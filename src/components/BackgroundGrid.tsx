import { useRef, useEffect } from 'react';

export const BackgroundGrid = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = window.innerWidth;
    let height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;

    // Grid configuration
    const spacing = 60; // Distance between grid points
    const cols = Math.ceil(width / spacing) + 2;
    const rows = Math.ceil(height / spacing) + 2;
    
    let points: any[] = [];
    let scrollY = window.scrollY;
    let targetScrollVelocity = 0;
    let currentScrollVelocity = 0;

    // Mouse interaction state
    let mouse = { x: -1000, y: -1000, radius: 250, isActive: false };

    class Point {
      x: number;
      y: number;
      baseX: number;
      baseY: number;
      col: number;
      row: number;

      constructor(x: number, y: number, col: number, row: number) {
        this.x = x;
        this.y = y;
        this.baseX = x;
        this.baseY = y;
        this.col = col;
        this.row = row;
      }

      update(time: number) {
        // 1. Base organic wave motion
        const waveX = Math.sin(time * 0.0005 + this.row * 0.5) * 5;
        const waveY = Math.cos(time * 0.0005 + this.col * 0.5) * 5;

        // 2. Scroll distortion (vertical stretch/compression)
        const scrollOffset = currentScrollVelocity * (Math.sin(this.col * 0.5) * 0.5 + 0.5);

        // 3. Mouse repulsion/distortion
        let dx = (this.baseX + waveX) - mouse.x;
        let dy = (this.baseY + waveY - scrollOffset) - mouse.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        
        let mousePushX = 0;
        let mousePushY = 0;

        if (mouse.isActive && distance < mouse.radius) {
          // Calculate force (stronger closer to center)
          const force = Math.pow((mouse.radius - distance) / mouse.radius, 2);
          
          // Push outward from mouse
          mousePushX = (dx / distance) * force * 40;
          mousePushY = (dy / distance) * force * 40;
        }

        // Apply all forces with easing back to base position
        this.x += ((this.baseX + waveX + mousePushX) - this.x) * 0.1;
        this.y += ((this.baseY + waveY - scrollOffset + mousePushY) - this.y) * 0.1;
      }
    }

    // Initialize grid points
    const initGrid = () => {
      points = [];
      for (let i = -1; i < cols; i++) {
        for (let j = -1; j < rows; j++) {
          points.push(new Point(i * spacing, j * spacing, i, j));
        }
      }
    };
    initGrid();

    const handleScroll = () => {
      const newScrollY = window.scrollY;
      targetScrollVelocity = newScrollY - scrollY;
      scrollY = newScrollY;
    };

    const handleMouseMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.isActive = true;
    };

    const handleMouseLeave = () => {
      mouse.isActive = false;
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseleave', handleMouseLeave);

    const handleResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
      initGrid(); // Rebuild grid on resize
    };

    window.addEventListener('resize', handleResize);

    let animationFrameId: number;
    let time = 0;

    const render = () => {
      time += 16;
      
      // Smooth scroll velocity
      currentScrollVelocity += (targetScrollVelocity - currentScrollVelocity) * 0.1;
      targetScrollVelocity *= 0.9; // Decay target

      ctx.clearRect(0, 0, width, height);

      // Update all points
      points.forEach(p => p.update(time));

      // Draw grid lines
      ctx.strokeStyle = 'rgba(26, 95, 255, 0.15)'; // Faint brand blue
      ctx.lineWidth = 1;
      ctx.beginPath();

      // Draw horizontal lines
      for (let j = -1; j < rows; j++) {
        let first = true;
        for (let i = -1; i < cols; i++) {
          const p = points.find(pt => pt.col === i && pt.row === j);
          if (p) {
            if (first) {
              ctx.moveTo(p.x, p.y);
              first = false;
            } else {
              ctx.lineTo(p.x, p.y);
            }
          }
        }
      }

      // Draw vertical lines
      for (let i = -1; i < cols; i++) {
        let first = true;
        for (let j = -1; j < rows; j++) {
          const p = points.find(pt => pt.col === i && pt.row === j);
          if (p) {
            if (first) {
              ctx.moveTo(p.x, p.y);
              first = false;
            } else {
              ctx.lineTo(p.x, p.y);
            }
          }
        }
      }
      ctx.stroke();

      // Draw intersection points
      ctx.fillStyle = 'rgba(26, 95, 255, 0.4)';
      points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // Draw mouse glow
      if (mouse.isActive) {
        const gradient = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, mouse.radius);
        gradient.addColorStop(0, 'rgba(26, 95, 255, 0.12)');
        gradient.addColorStop(1, 'rgba(26, 95, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, mouse.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <canvas 
      ref={canvasRef} 
      className="fixed inset-0 pointer-events-none z-0 opacity-100"
    />
  );
};
