
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { SupportedLanguage, Transcription, TranslationState, MeetingSession } from './types';
import { decode, encode, decodeAudioData, createBlob } from './utils/audio-utils';
import { Visualizer } from './components/Visualizer';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';
const SESSION_MAX_DURATION = 4.5 * 60 * 1000; // 4.5 minutes rotation

const App: React.FC = () => {
  const [sourceLang, setSourceLang] = useState<SupportedLanguage>(SupportedLanguage.ENGLISH);
  const [targetLang, setTargetLang] = useState<SupportedLanguage>(SupportedLanguage.CHINESE);
  const [status, setStatus] = useState<TranslationState>({ 
    isActive: false, 
    isConnecting: false, 
    isReconnecting: false,
    error: null 
  });
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [sessionAge, setSessionAge] = useState(0);
  const [viewMode, setViewMode] = useState<'live' | 'minutes'>('live');
  const [meetingTitle, setMeetingTitle] = useState('Global Strategy Meeting');
  
  // Audio Refs
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Session management
  const sessionRef = useRef<any>(null);
  const isUserInitiatedStop = useRef<boolean>(true);
  const sessionStartTimeRef = useRef<number>(0);
  const rotationTimerRef = useRef<number | null>(null);
  const transcriptListEndRef = useRef<HTMLDivElement>(null);

  // Buffer for cross-session continuity
  const historyRef = useRef<Transcription[]>([]);
  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  useEffect(() => {
    historyRef.current = transcriptions;
    if (viewMode === 'live') {
      transcriptListEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcriptions, viewMode]);

  const cleanupAudio = useCallback(() => {
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (audioContextInRef.current) {
      audioContextInRef.current.close();
      audioContextInRef.current = null;
    }
    if (audioContextOutRef.current) {
      audioContextOutRef.current.close();
      audioContextOutRef.current = null;
    }
    sourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const stopTranslation = useCallback(() => {
    isUserInitiatedStop.current = true;
    if (rotationTimerRef.current) window.clearTimeout(rotationTimerRef.current);
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    cleanupAudio();
    setStatus({ isActive: false, isConnecting: false, isReconnecting: false, error: null });
    setSessionAge(0);
  }, [cleanupAudio]);

  const startTranslation = async (isRotation = false) => {
    try {
      if (!isRotation) {
        isUserInitiatedStop.current = false;
        setStatus(prev => ({ ...prev, isConnecting: true, error: null }));
      } else {
        // Just set the flag, don't block the UI
        setStatus(prev => ({ ...prev, isReconnecting: true }));
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // During rotation, we DON'T cleanup audio immediately to keep the stream smooth
      if (!isRotation) cleanupAudio();
      
      if (!audioContextInRef.current) {
        audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!audioContextOutRef.current) {
        audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Inject more substantial context for rotation
      const recentHistory = historyRef.current.slice(-15).map(t => 
        `[${t.timestamp.toLocaleTimeString()}] ${t.type === 'user' ? 'Input' : 'Translation'}: ${t.text}`
      ).join('\n');
      
      const rotationContext = isRotation 
        ? `This is a session rotation. Continue translating naturally. Previous context:\n${recentHistory}` 
        : "STARTING NEW MEETING.";

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            // Success! Replace the old session reference
            const oldSession = sessionRef.current;
            sessionPromise.then(newSession => {
              sessionRef.current = newSession;
              if (oldSession && oldSession !== newSession) {
                console.log("Seamless rotation: Closing old session...");
                oldSession.close();
              }
            });

            setStatus({ isActive: true, isConnecting: false, isReconnecting: false, error: null });
            sessionStartTimeRef.current = Date.now();
            setSessionAge(0);

            if (rotationTimerRef.current) window.clearTimeout(rotationTimerRef.current);
            rotationTimerRef.current = window.setTimeout(() => {
              if (!isUserInitiatedStop.current) startTranslation(true);
            }, SESSION_MAX_DURATION);

            // Setup audio only if not already running or if we need a fresh processor
            if (!scriptProcessorRef.current) {
              const source = audioContextInRef.current!.createMediaStreamSource(stream);
              const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
              scriptProcessorRef.current = scriptProcessor;
              
              scriptProcessor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                // Always use current session reference to send data
                if (sessionRef.current && !isUserInitiatedStop.current) {
                  sessionRef.current.sendRealtimeInput({ media: pcmBlob });
                }
                
                // Update local session age UI occasionally
                if (Date.now() % 1000 < 100) {
                  setSessionAge(Math.floor((Date.now() - sessionStartTimeRef.current) / 1000));
                }
              };
              
              source.connect(scriptProcessor);
              scriptProcessor.connect(audioContextInRef.current!.destination);
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            // Only process audio from current active session handled via sessionRef.current
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && audioContextOutRef.current) {
              const ctx = audioContextOutRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.onended = () => sourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) currentInputTransRef.current += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) currentOutputTransRef.current += message.serverContent.outputTranscription.text;

            if (message.serverContent?.turnComplete) {
              const uText = currentInputTransRef.current.trim();
              const mText = currentOutputTransRef.current.trim();
              if (uText || mText) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(uText ? [{ id: Math.random().toString(), type: 'user' as const, text: uText, timestamp: new Date() }] : []),
                  ...(mText ? [{ id: Math.random().toString(), type: 'model' as const, text: mText, timestamp: new Date() }] : [])
                ]);
              }
              currentInputTransRef.current = '';
              currentOutputTransRef.current = '';
            }
          },
          onclose: () => {
            // If it closed unexpectedly (not a rotation), try to recover
            if (!isUserInitiatedStop.current && !status.isReconnecting) {
              console.warn("Session closed unexpectedly. Attempting recovery...");
              startTranslation(true);
            }
          },
          onerror: (e) => {
             console.error("Session internal error:", e);
             if (isRotation) {
               setStatus(prev => ({ ...prev, isReconnecting: false }));
             }
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          systemInstruction: `CONTEXT: ${rotationContext}
            ROLE: Meeting Secretary and Professional Simultaneous Interpreter. 
            ENVIRONMENT: Multi-participant corporate meeting.
            SOURCE: ${sourceLang}. TARGET: ${targetLang}.
            INSTRUCTIONS:
            1. Provide instant translation of all recognized speech.
            2. For multi-speaker detection, use prefixes like "[Participant]" if voice changes.
            3. Maintain formal, executive-level tone.
            4. If this is a rotation (see context), continue previous threads seamlessly.`
        }
      });
      
    } catch (err: any) {
      console.error('Connection Initiation Failed:', err);
      if (!isRotation) {
        setStatus({ isActive: false, isConnecting: false, isReconnecting: false, error: err.message || 'Connection failed' });
      } else {
        // Rotation failed, try again in a bit but don't hang UI
        setStatus(prev => ({ ...prev, isReconnecting: false }));
        setTimeout(() => !isUserInitiatedStop.current && startTranslation(true), 5000);
      }
    }
  };

  const downloadMinutes = () => {
    const content = transcriptions.map(t => 
      `[${t.timestamp.toLocaleTimeString()}] ${t.type === 'user' ? 'ORIGINAL' : 'TRANSLATED'}: ${t.text}`
    ).join('\n\n');
    
    const blob = new Blob([`MEETING MINUTES: ${meetingTitle}\nDATE: ${new Date().toLocaleDateString()}\n\n${content}`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${meetingTitle.replace(/\s+/g, '_')}_Minutes.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const progressPercentage = (sessionAge / (SESSION_MAX_DURATION / 1000)) * 100;

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col font-sans selection:bg-indigo-100 overflow-hidden h-screen">
      {/* Premium Header */}
      <header className="bg-white border-b border-slate-200 z-30 px-6 py-3 flex-shrink-0 shadow-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-100 transition-all hover:scale-105">
              <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            </div>
            <div>
              <input 
                type="text" 
                value={meetingTitle}
                onChange={(e) => setMeetingTitle(e.target.value)}
                className="text-lg font-black text-slate-800 bg-transparent border-b border-transparent hover:border-slate-200 focus:border-indigo-600 outline-none transition-all w-64"
              />
              <div className="flex items-center gap-2 mt-0.5">
                <div className={`w-2 h-2 rounded-full ${status.isActive ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`}></div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  {status.isActive ? 'Active Recording' : 'Standby'}
                </span>
                {status.isReconnecting && (
                  <span className="flex items-center gap-1.5 ml-2 text-[10px] font-black text-indigo-500 animate-pulse bg-indigo-50 px-2 py-0.5 rounded-full">
                    <span className="w-1 h-1 bg-indigo-500 rounded-full animate-ping"></span>
                    SYNCING PIPELINE
                  </span>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex items-center bg-slate-100 rounded-xl p-1 shadow-inner">
              <button 
                onClick={() => setViewMode('live')}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${viewMode === 'live' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                LIVE FEED
              </button>
              <button 
                onClick={() => setViewMode('minutes')}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${viewMode === 'minutes' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                MINUTES
              </button>
            </div>
            <button 
              onClick={downloadMinutes}
              disabled={transcriptions.length === 0}
              className="p-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 hover:text-indigo-600 hover:border-indigo-200 transition-all disabled:opacity-30 group"
              title="Download Minutes"
            >
              <svg className="w-5 h-5 group-hover:translate-y-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Split */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Controls & Settings */}
        <aside className="w-80 bg-white border-r border-slate-200 p-6 flex flex-col gap-8 flex-shrink-0 z-20 overflow-y-auto">
          <section>
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Meeting Settings</h3>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Speaker Language</label>
                <div className="relative group">
                  <select 
                    disabled={status.isActive}
                    value={sourceLang}
                    onChange={(e) => setSourceLang(e.target.value as SupportedLanguage)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none appearance-none cursor-pointer hover:bg-slate-100 transition-all disabled:cursor-not-allowed"
                  >
                    {Object.values(SupportedLanguage).map(lang => (
                      <option key={lang} value={lang}>{lang}</option>
                    ))}
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                </div>
              </div>
              <div className="flex justify-center">
                <div className="p-2 bg-indigo-50 rounded-full text-indigo-600 shadow-sm border border-indigo-100">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Target Language</label>
                <div className="relative group">
                  <select 
                    disabled={status.isActive}
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value as SupportedLanguage)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none appearance-none cursor-pointer hover:bg-slate-100 transition-all disabled:cursor-not-allowed"
                  >
                    {Object.values(SupportedLanguage).map(lang => (
                      <option key={lang} value={lang}>{lang}</option>
                    ))}
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="flex-1 flex flex-col justify-end gap-6">
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 shadow-inner">
               <div className="flex justify-between items-center mb-2">
                 <span className="text-[9px] font-black text-slate-400 uppercase">Buffer Freshness</span>
                 <span className="text-[9px] font-bold text-indigo-500">{Math.floor(sessionAge / 60)}:{(sessionAge % 60).toString().padStart(2,'0')}</span>
               </div>
               <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                 <div 
                   className={`h-full transition-all duration-1000 ${progressPercentage > 85 ? 'bg-amber-500 animate-pulse' : 'bg-indigo-500'}`}
                   style={{ width: `${progressPercentage}%` }}
                 ></div>
               </div>
            </div>

            <div className="flex flex-col gap-3">
              {!status.isActive && !status.isReconnecting ? (
                <button
                  onClick={() => startTranslation()}
                  disabled={status.isConnecting}
                  className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black uppercase tracking-widest text-xs shadow-lg shadow-indigo-100 transition-all hover:-translate-y-1 active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50"
                >
                  {status.isConnecting ? (
                    <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                  ) : (
                    <>
                      <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center shadow-inner">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" /></svg>
                      </div>
                      <span>Open Meeting Pipeline</span>
                    </>
                  )}
                </button>
              ) : (
                <button
                  onClick={stopTranslation}
                  className="w-full py-4 bg-slate-900 hover:bg-black text-white rounded-2xl font-black uppercase tracking-widest text-xs shadow-lg transition-all active:scale-95 flex items-center justify-center gap-3"
                >
                  <div className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                  </div>
                  <span>Terminate Session</span>
                </button>
              )}
            </div>
          </section>
        </aside>

        {/* Main Content View */}
        <main className="flex-1 overflow-hidden flex flex-col relative bg-white">
          {/* Visualizer Floating Bar */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 w-72 bg-white/90 backdrop-blur-md rounded-full border border-slate-200 shadow-2xl p-2 flex items-center justify-center h-14">
            {status.isActive ? (
              <Visualizer isActive={true} />
            ) : (
              <div className="flex gap-2 items-center opacity-10">
                {[...Array(12)].map((_, i) => (
                  <div key={i} className="w-1 h-4 bg-slate-900 rounded-full animate-pulse" style={{ animationDelay: `${i * 100}ms` }}></div>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-10 py-24">
            {viewMode === 'live' ? (
              <div className="max-w-4xl mx-auto space-y-10 pb-10">
                {transcriptions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-[50vh] text-center space-y-8 animate-in fade-in zoom-in-95 duration-700">
                    <div className="relative">
                      <div className="absolute inset-0 bg-indigo-100 rounded-full blur-3xl opacity-40 scale-150 animate-pulse"></div>
                      <div className="relative w-32 h-32 bg-white rounded-full flex items-center justify-center border border-slate-100 shadow-xl">
                        <svg className="w-12 h-12 text-indigo-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 00-2 2h2v4l.586-.586z" /></svg>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <h2 className="text-2xl font-black text-slate-800 tracking-tight">Listening for Participants...</h2>
                      <p className="text-slate-400 text-sm max-w-sm font-medium">
                        OmniMeeting is ready. Start speaking in <span className="text-indigo-500 font-bold">{sourceLang}</span> and I'll generate the minutes in real-time.
                      </p>
                    </div>
                  </div>
                ) : (
                  transcriptions.map((t, idx) => (
                    <div key={t.id} className={`flex flex-col ${t.type === 'user' ? 'items-end' : 'items-start'} group animate-in fade-in slide-in-from-bottom-4 duration-500`}>
                      <div className={`relative max-w-[85%] rounded-[2.5rem] px-8 py-6 shadow-sm transition-all group-hover:shadow-md ${
                        t.type === 'user' 
                          ? 'bg-gradient-to-br from-indigo-600 to-indigo-800 text-white rounded-tr-none' 
                          : 'bg-[#F1F5F9] text-slate-800 rounded-tl-none border border-slate-200'
                      }`}>
                        <p className="text-base md:text-lg leading-relaxed font-semibold">{t.text}</p>
                        
                        {/* Time stamp bubble */}
                        <div className={`absolute -top-3 ${t.type === 'user' ? 'right-4' : 'left-4'} bg-white px-3 py-1 rounded-full text-[10px] font-black shadow-sm border border-slate-100 ${t.type === 'user' ? 'text-indigo-600' : 'text-slate-400'}`}>
                          {t.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <div ref={transcriptListEndRef} />
              </div>
            ) : (
              <div className="max-w-4xl mx-auto bg-white rounded-[3rem] p-16 border border-slate-100 shadow-2xl">
                <div className="border-b-2 border-slate-100 pb-10 mb-10 flex justify-between items-end">
                   <div className="space-y-2">
                     <h2 className="text-4xl font-black text-slate-900 tracking-tighter leading-none">{meetingTitle}</h2>
                     <p className="text-indigo-500 font-black uppercase tracking-[0.2em] text-xs">Official Transcription • {new Date().toLocaleDateString()}</p>
                   </div>
                   <div className="text-right">
                     <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest mb-1">Methodology</p>
                     <p className="text-sm font-black text-slate-700 italic">Neural Live Processing</p>
                   </div>
                </div>
                
                <div className="space-y-10">
                  {transcriptions.length === 0 ? (
                    <div className="py-24 text-center">
                      <p className="text-slate-300 font-bold italic">Minutes record is currently empty.</p>
                    </div>
                  ) : (
                    transcriptions.map((t, idx) => (
                      <div key={t.id} className="grid grid-cols-[120px_1fr] gap-10 group">
                        <div className="text-[11px] font-black text-slate-300 uppercase pt-2 tabular-nums tracking-tighter group-hover:text-indigo-400 transition-colors">
                          {t.timestamp.toLocaleTimeString()}
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center gap-3">
                            <span className={`text-[9px] font-black px-2.5 py-1 rounded-lg uppercase tracking-wider shadow-sm ${t.type === 'user' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                              {t.type === 'user' ? 'Original Input' : 'Interpreter'}
                            </span>
                          </div>
                          <p className={`text-lg leading-relaxed ${t.type === 'user' ? 'text-slate-400 font-medium' : 'text-slate-800 font-bold'}`}>
                            {t.text}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      
      {/* Dynamic Sync Status (Instead of full screen) */}
      {status.isReconnecting && (
         <div className="fixed bottom-6 right-6 z-50 bg-white/90 backdrop-blur-xl px-6 py-4 rounded-3xl shadow-2xl border border-indigo-100 flex items-center gap-4 animate-in slide-in-from-right duration-500">
            <div className="relative w-8 h-8">
               <div className="absolute inset-0 border-4 border-indigo-50 rounded-full"></div>
               <div className="absolute inset-0 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
            <div>
               <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Neural Pipeline</p>
               <p className="text-sm font-black text-indigo-600 uppercase">Seamless Rotation...</p>
            </div>
         </div>
      )}

      {/* Error Notification */}
      {status.error && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 bg-red-600 text-white px-8 py-4 rounded-3xl shadow-2xl font-black text-xs uppercase tracking-widest flex items-center gap-4 animate-in slide-in-from-bottom duration-300">
          <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
          </div>
          <span>System Conflict: {status.error}</span>
          <button onClick={() => setStatus(s => ({...s, error: null}))} className="ml-4 hover:bg-white/10 p-2 rounded-full transition-colors">✕</button>
        </div>
      )}
    </div>
  );
};

export default App;
