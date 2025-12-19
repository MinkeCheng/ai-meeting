
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
}

export const Visualizer: React.FC<VisualizerProps> = ({ isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Fix: useRef requires 1 argument (initialValue) in strict TypeScript environments
  const animationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!isActive) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let startTime = Date.now();

    const draw = () => {
      const now = Date.now();
      const delta = (now - startTime) / 1000;
      
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#3b82f6';
      ctx.lineCap = 'round';

      const centerY = canvas.height / 2;
      const width = canvas.width;
      const step = 4;
      
      for (let x = 0; x < width; x += step) {
        const amplitude = Math.sin(x * 0.05 + delta * 5) * 15 * Math.sin(delta * 2);
        const y = centerY + amplitude;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.stroke();
      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isActive]);

  return (
    <canvas 
      ref={canvasRef} 
      width={300} 
      height={80} 
      className="w-full h-20 opacity-80"
    />
  );
};
