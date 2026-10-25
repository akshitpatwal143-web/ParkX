import React, { useRef, useState, useEffect } from 'react';
import { Play, Pause, RotateCcw, Crosshair, Zap, Eye, ShieldCheck, Gauge, Compass } from 'lucide-react';

export default function Demo() {
  const canvasRef = useRef(null);

  const [isRunning, setIsRunning] = useState(false);
  const [parkingMode, setParkingMode] = useState('parallel'); // 'parallel' | 'bay'
  const [showLidar, setShowLidar] = useState(true);
  const [simStatus, setSimStatus] = useState('STANDBY'); // STANDBY, SCANNING, EXECUTING, PARKED
  
  // Real-time telemetry states
  const [steerAngle, setSteerAngle] = useState(0);
  const [speedVal, setSpeedVal] = useState(0);
  const [curbDistance, setCurbDistance] = useState(450);
  const [progressVal, setProgressVal] = useState(0);

  // Simulation physics state
  const simState = useRef({
    t: 0,
    carX: 180,
    carY: 260,
    carAngle: 0,
    speed: 0,
    steer: 0,
    animId: null
  });

  // Reset simulation to initial position
  const resetSimulation = () => {
    setIsRunning(false);
    setSimStatus('STANDBY');
    setSteerAngle(0);
    setSpeedVal(0);
    setCurbDistance(450);
    setProgressVal(0);

    const s = simState.current;
    s.t = 0;
    s.carX = 160;
    s.carY = 260;
    s.carAngle = 0;
    s.speed = 0;
    s.steer = 0;
  };

  const toggleRun = () => {
    if (simStatus === 'PARKED') {
      resetSimulation();
      setTimeout(() => setIsRunning(true), 100);
      return;
    }
    setIsRunning((prev) => !prev);
  };

  useEffect(() => {
    resetSimulation();
  }, [parkingMode]);

  // Main simulation render & physics loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const s = simState.current;

    const render = () => {
      const w = canvas.width;
      const h = canvas.height;

      // Update simulation step if running
      if (isRunning && s.t < 1) {
        s.t += 0.0035;
        if (s.t > 1) s.t = 1;

        const t = s.t;
        setProgressVal(Math.round(t * 100));

        if (parkingMode === 'parallel') {
          // Parallel parking trajectory
          if (t < 0.25) {
            setSimStatus('SCANNING');
            s.speed = 12;
            s.carX = 160 + t * 4 * 160;
            s.carY = 260;
            s.carAngle = 0;
            s.steer = 0;
            setCurbDistance(450 - t * 40);
          } else if (t < 0.65) {
            setSimStatus('REVERSING');
            const sub = (t - 0.25) / 0.4;
            s.speed = -4.5;
            s.steer = 28.5 * Math.sin(sub * Math.PI);
            s.carX = 320 - sub * 120;
            s.carY = 260 + Math.sin(sub * Math.PI * 0.5) * 90;
            s.carAngle = Math.sin(sub * Math.PI) * 0.48;
            setCurbDistance(Math.round(410 - sub * 310));
          } else if (t < 0.95) {
            setSimStatus('ALIGNING');
            const sub = (t - 0.65) / 0.3;
            s.speed = -2.0;
            s.steer = -18 * (1 - sub);
            s.carX = 200 + sub * 20;
            s.carY = 350 + (1 - Math.cos(sub * Math.PI * 0.5)) * 10;
            s.carAngle = (1 - sub) * 0.2;
            setCurbDistance(Math.round(100 - sub * 45));
          } else {
            setSimStatus('PARKED');
            s.speed = 0;
            s.steer = 0;
            s.carAngle = 0;
            setCurbDistance(55);
            setIsRunning(false);
          }
        } else {
          // Bay / 90 degree parking trajectory
          if (t < 0.3) {
            setSimStatus('SCANNING');
            s.speed = 10;
            s.carX = 160 + (t / 0.3) * 160;
            s.carY = 230;
            s.carAngle = 0;
            s.steer = 0;
          } else if (t < 0.85) {
            setSimStatus('TURNING');
            const sub = (t - 0.3) / 0.55;
            s.speed = -3.8;
            s.steer = 32.0;
            s.carX = 320 - sub * 70;
            s.carY = 230 + sub * 130;
            s.carAngle = sub * (Math.PI / 2);
            setCurbDistance(Math.round(380 - sub * 300));
          } else {
            setSimStatus('PARKED');
            s.speed = 0;
            s.steer = 0;
            s.carAngle = Math.PI / 2;
            setCurbDistance(60);
            setIsRunning(false);
          }
        }

        setSteerAngle(Math.round(s.steer));
        setSpeedVal(Math.abs(Number(s.speed.toFixed(1))));
      }

      // --- DRAW CANVAS SCENARIO ---
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);

      // Grid Lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 30) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += 30) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Roadway Lanes
      ctx.fillStyle = '#111111';
      ctx.fillRect(0, 180, w, 150);

      // Center Dotted Lane Marker
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.setLineDash([12, 12]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 210);
      ctx.lineTo(w, 210);
      ctx.stroke();
      ctx.setLineDash([]);

      // Curb & Sidewalk
      ctx.fillStyle = '#171717';
      ctx.fillRect(0, 330, w, 150);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 330);
      ctx.lineTo(w, 330);
      ctx.stroke();

      // Parking Bays (Parallel or Bay)
      if (parkingMode === 'parallel') {
        const bayW = 160;
        const bayH = 70;
        const bays = [
          { x: 50, occupied: true },
          { x: 230, occupied: false }, // TARGET BAY
          { x: 410, occupied: true }
        ];

        bays.forEach((b) => {
          ctx.strokeStyle = b.occupied ? 'rgba(255, 255, 255, 0.2)' : '#2ee6ca';
          ctx.lineWidth = b.occupied ? 1.5 : 2;
          ctx.strokeRect(b.x, 340, bayW, bayH);

          if (!b.occupied) {
            ctx.fillStyle = 'rgba(46, 230, 202, 0.06)';
            ctx.fillRect(b.x, 340, bayW, bayH);
            ctx.fillStyle = '#2ee6ca';
            ctx.font = '10px JetBrains Mono';
            ctx.fillText('TARGET BAY [P1]', b.x + 24, 380);
          } else {
            // Draw parked obstacle car
            ctx.fillStyle = '#242424';
            ctx.fillRect(b.x + 20, 350, 120, 50);
            ctx.strokeStyle = '#383838';
            ctx.strokeRect(b.x + 20, 350, 120, 50);
            ctx.fillStyle = '#555';
            ctx.font = '9px JetBrains Mono';
            ctx.fillText('OCCUPIED', b.x + 50, 378);
          }
        });

        // Planned Trajectory path
        ctx.strokeStyle = 'rgba(46, 230, 202, 0.4)';
        ctx.setLineDash([4, 6]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(160, 260);
        ctx.bezierCurveTo(320, 260, 280, 360, 230 + 30, 365);
        ctx.stroke();
        ctx.setLineDash([]);

      } else {
        // 90 degree Bay Parking
        const bayW = 75;
        const bayH = 110;
        const bays = [
          { x: 100, occupied: true },
          { x: 200, occupied: false }, // TARGET
          { x: 300, occupied: true },
          { x: 400, occupied: true }
        ];

        bays.forEach((b) => {
          ctx.strokeStyle = b.occupied ? 'rgba(255, 255, 255, 0.2)' : '#2ee6ca';
          ctx.lineWidth = b.occupied ? 1.5 : 2;
          ctx.strokeRect(b.x, 340, bayW, bayH);

          if (!b.occupied) {
            ctx.fillStyle = 'rgba(46, 230, 202, 0.08)';
            ctx.fillRect(b.x, 340, bayW, bayH);
            ctx.fillStyle = '#2ee6ca';
            ctx.font = '9px JetBrains Mono';
            ctx.fillText('TARGET', b.x + 18, 395);
          } else {
            ctx.fillStyle = '#242424';
            ctx.fillRect(b.x + 10, 350, 55, 90);
            ctx.strokeStyle = '#383838';
            ctx.strokeRect(b.x + 10, 350, 55, 90);
          }
        });
      }

      // Draw Autonomous Car
      ctx.save();
      ctx.translate(s.carX, s.carY);
      ctx.rotate(s.carAngle);

      const carLength = 80;
      const carWidth = 42;

      // Draw LiDAR Beams
      if (showLidar) {
        ctx.save();
        const beamCount = 14;
        for (let i = 0; i < beamCount; i++) {
          const angle = -Math.PI / 2 + (i / (beamCount - 1)) * Math.PI;
          const rayLen = 50 + Math.sin(Date.now() * 0.005 + i) * 12;
          ctx.strokeStyle = 'rgba(46, 230, 202, 0.25)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(carLength / 2, 0);
          ctx.lineTo(carLength / 2 + Math.cos(angle) * rayLen, Math.sin(angle) * rayLen);
          ctx.stroke();

          // Rear rays
          ctx.beginPath();
          ctx.moveTo(-carLength / 2, 0);
          ctx.lineTo(-carLength / 2 - Math.cos(angle) * (rayLen * 0.8), Math.sin(angle) * (rayLen * 0.8));
          ctx.stroke();
        }
        ctx.restore();
      }

      // Car Body (Mint / Cyan Sport chassis matching project frames)
      ctx.fillStyle = '#2ee6ca';
      ctx.beginPath();
      ctx.roundRect(-carLength / 2, -carWidth / 2, carLength, carWidth, 8);
      ctx.fill();

      // Car Roof & Glass Cockpit
      ctx.fillStyle = '#141414';
      ctx.beginPath();
      ctx.roundRect(-carLength / 2 + 18, -carWidth / 2 + 6, carLength - 36, carWidth - 12, 5);
      ctx.fill();

      // Windshield & Sunroof details
      ctx.fillStyle = '#252525';
      ctx.fillRect(-carLength / 2 + 34, -carWidth / 2 + 9, 14, carWidth - 18);

      // Headlights / Tail lights
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(carLength / 2 - 3, -carWidth / 2 + 3, 3, 7);
      ctx.fillRect(carLength / 2 - 3, carWidth / 2 - 10, 3, 7);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(-carLength / 2, -carWidth / 2 + 4, 3, 7);
      ctx.fillRect(-carLength / 2, carWidth / 2 - 11, 3, 7);

      ctx.restore();

      s.animId = requestAnimationFrame(render);
    };

    s.animId = requestAnimationFrame(render);
    return () => {
      if (s.animId) cancelAnimationFrame(s.animId);
    };
  }, [isRunning, parkingMode, showLidar]);

  return (
    <section id="demo" className="relative w-full py-32 px-6 md:px-12 bg-[#080808] border-t border-white/[0.06]">
      <div className="max-w-7xl mx-auto">
        
        {/* Section Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between mb-16 pb-8 border-b border-white/[0.08]">
          <div>
            <div className="flex items-center space-x-3 mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-[#2ee6ca]" />
              <span className="text-xs font-mono tracking-widest text-[#2ee6ca] uppercase">
                04 // Interactive Simulation
              </span>
            </div>
            <h2 className="font-display text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight text-white uppercase leading-none">
              PARKX DEMO <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-neutral-300 to-neutral-600">
                SANDBOX.
              </span>
            </h2>
          </div>

          <div className="mt-6 md:mt-0">
            <span className="text-xs font-mono text-neutral-400 uppercase tracking-widest">
              AUTONOMOUS TRAJECTORY SIMULATOR
            </span>
          </div>
        </div>

        {/* Simulator Container */}
        <div className="rounded-2xl bg-[#0d0d0d] border border-white/[0.12] overflow-hidden shadow-2xl relative">
          
          {/* Top Simulation Toolbar */}
          <div className="p-4 sm:p-6 bg-[#111111] border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
            
            {/* Status Indicator */}
            <div className="flex items-center space-x-3">
              <span className={`w-2.5 h-2.5 rounded-full ${
                simStatus === 'PARKED'
                  ? 'bg-emerald-400'
                  : isRunning
                  ? 'bg-[#2ee6ca] animate-pulse'
                  : 'bg-amber-400'
              }`} />
              <span className="font-mono text-xs text-white uppercase tracking-wider">
                STATUS: // {simStatus}
              </span>
            </div>

            {/* Mode Selectors */}
            <div className="flex items-center space-x-2 text-xs font-mono">
              <button
                onClick={() => setParkingMode('parallel')}
                className={`px-3 py-1.5 rounded border transition-colors ${
                  parkingMode === 'parallel'
                    ? 'border-[#2ee6ca] bg-[#2ee6ca]/10 text-white'
                    : 'border-white/10 text-neutral-400 hover:text-white'
                }`}
              >
                Parallel Docking
              </button>
              <button
                onClick={() => setParkingMode('bay')}
                className={`px-3 py-1.5 rounded border transition-colors ${
                  parkingMode === 'bay'
                    ? 'border-[#2ee6ca] bg-[#2ee6ca]/10 text-white'
                    : 'border-white/10 text-neutral-400 hover:text-white'
                }`}
              >
                Bay 90° Maneuver
              </button>
            </div>

            {/* Sensor Toggle */}
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setShowLidar(!showLidar)}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded border text-xs font-mono transition-colors ${
                  showLidar
                    ? 'border-[#2ee6ca]/40 text-[#2ee6ca] bg-[#2ee6ca]/10'
                    : 'border-white/10 text-neutral-400'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                <span>LiDAR {showLidar ? 'ON' : 'OFF'}</span>
              </button>
            </div>

          </div>

          {/* Interactive Simulation Viewport Canvas */}
          <div className="relative w-full aspect-[16/9] max-h-[520px] bg-[#090909] overflow-hidden">
            <canvas
              ref={canvasRef}
              width={700}
              height={450}
              className="w-full h-full object-contain block cursor-crosshair"
            />

            {/* Real-time Canvas HUD Telemetry Overlay */}
            <div className="absolute top-4 left-4 flex flex-col space-y-1.5 pointer-events-none">
              <div className="px-3 py-1.5 rounded bg-black/60 backdrop-blur-md border border-white/10 text-[11px] font-mono text-neutral-300">
                <span>STEER ANGLE: </span>
                <span className="text-[#2ee6ca] font-semibold">{steerAngle > 0 ? `+${steerAngle}` : steerAngle}°</span>
              </div>
              <div className="px-3 py-1.5 rounded bg-black/60 backdrop-blur-md border border-white/10 text-[11px] font-mono text-neutral-300">
                <span>VELOCITY: </span>
                <span className="text-white font-semibold">{speedVal} km/h</span>
              </div>
              <div className="px-3 py-1.5 rounded bg-black/60 backdrop-blur-md border border-white/10 text-[11px] font-mono text-neutral-300">
                <span>CURB DISTANCE: </span>
                <span className="text-[#2ee6ca] font-semibold">{curbDistance} mm</span>
              </div>
            </div>

            {/* Bottom Progress Bar */}
            <div className="absolute bottom-4 right-4 px-3 py-1.5 rounded bg-black/60 backdrop-blur-md border border-white/10 text-[11px] font-mono text-neutral-400 pointer-events-none">
              <span>TRAJECTORY COMPLETION: </span>
              <span className="text-[#2ee6ca] font-semibold">{progressVal}%</span>
            </div>
          </div>

          {/* Bottom Execution Bar */}
          <div className="p-6 bg-[#0f0f0f] border-t border-white/[0.08] flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center space-x-4">
              <button
                onClick={toggleRun}
                className="flex items-center space-x-2 px-6 py-3 rounded bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono text-xs uppercase tracking-widest font-semibold transition-all shadow-[0_0_25px_rgba(46,230,202,0.3)] hover:scale-[1.02]"
              >
                {isRunning ? (
                  <>
                    <Pause className="w-4 h-4 fill-black" />
                    <span>Pause Simulation</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-black" />
                    <span>{simStatus === 'PARKED' ? 'Restart Simulation' : 'Start Simulation'}</span>
                  </>
                )}
              </button>

              <button
                onClick={resetSimulation}
                className="flex items-center space-x-2 px-4 py-3 rounded border border-white/10 hover:border-white/30 text-neutral-300 hover:text-white font-mono text-xs uppercase tracking-widest transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            </div>

            <div className="text-xs font-mono text-neutral-400">
              * Interactive sandbox modeling Clothoid curve vehicle docking.
            </div>
          </div>

        </div>

      </div>
    </section>
  );
}
