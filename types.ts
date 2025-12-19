
export interface Transcription {
  id: string;
  type: 'user' | 'model';
  text: string;
  timestamp: Date;
  speakerLabel?: string;
}

export enum SupportedLanguage {
  CHINESE = 'Chinese',
  ENGLISH = 'English',
  JAPANESE = 'Japanese',
  KOREAN = 'Korean',
  FRENCH = 'French',
  GERMAN = 'German',
  SPANISH = 'Spanish',
  RUSSIAN = 'Russian',
  PORTUGUESE = 'Portuguese',
  ITALIAN = 'Italian'
}

export interface TranslationState {
  isActive: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  error: string | null;
}

export interface MeetingSession {
  id: string;
  startTime: Date;
  title: string;
}
