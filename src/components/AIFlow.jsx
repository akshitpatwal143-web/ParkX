import React, { useState, useEffect } from 'react';
import { Radio, ScanLine, Brain, Navigation, CheckCircle2, ChevronRight, Activity } from 'lucide-react';

export default function AIFlow() {
  const [activeStep, setActiveStep] = useState(2); // default DECISION

  const steps = [
    {
      id: 0,
      name: 'ENVIRONMENT',
      tag: 'INPUT STREAM',
      icon: Radio,
      summary: 'Continuous 360° spatial capture from ultrasonic sensors and overhead perspective cameras.',
      metrics: ['Point cloud capture: 30Hz', 'Range: 0.2m - 15m', 'Field of View: 360°'],
      statusText: 'RAW SENSOR FEEDS ACTIVE'
    },
    {
      id: 1,
      name: 'PERCEPTION',
      tag: 'NEURAL EXTRACTION',
      icon: ScanLine,
      summary: 'Semantic road segmentation classifies free parking slots, pedestrian markers, and boundary curbs.',
      metrics: ['Bounding Box Precision: 99.4%', 'Latency: 6.2ms', 'Confidence: 0.98'],
      statusText: 'OCCUPANCY GRID COMPUTED'
    },
    {
      id: 2,
      name: 'DECISION',
      tag: 'COGNITIVE LOGIC',
      icon: Brain,
      summary: 'Arbitration engine assesses safety clearances, legal bay dimensions, and validates target maneuver.',
      metrics: ['Collision Margin: +350mm', 'Maneuver: Reverse Parallel', 'Cycle: 200Hz'],
      statusText: 'TRAJECTORY APPROVED'
    },
    {
      id: 3,
      name: 'PATH',
      tag: 'KINEMATIC PLANNING',
      icon: Navigation,
      summary: 'Clothoid spiral curves generate smooth steering transitions with continuous curvature derivatives.',
      metrics: ['Steering Lock: Max 32.5°', 'Target Velocity: 3.2 km/h', 'Curvature: C2 Continuous'],
      statusText: 'ACTUATOR VECTORS ISSUED'
    },
    {
      id: 4,
      name: 'PARK',
      tag: 'BAY LOCK ACQUIRED',
      icon: CheckCircle2,
      summary: 'Vehicle achieves zero-tolerance bay docking with automated electronic brake engagement and neutral lock.',
      metrics: ['Angular Offset: < 0.2°', 'Lateral Offset: 24mm', 'Final State: SECURED'],
      statusText: 'PARKING COMPLETE'
    }
  ];

  // Auto-cycle through steps periodically if not hovered
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % steps.length);
    }, 4000);
    return () => clearInterval(timer);
  }, [steps.length]);

  return (
    <section className="relative w-full py-32 px-6 md:px-12 bg-transparent overflow-hidden">
      {/* Background Subtle Radar Glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-[#2ee6ca]/5 rounded-full blur-[140px] pointer-events-none" />

      <div className="max-w-7xl mx-auto relative z-10">
        
        {/* Section Heading */}
        <div className="max-w-3xl mb-20">
          <div className="flex items-center space-x-3 mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2ee6ca]" />
            <span className="text-xs font-mono tracking-widest text-[#2ee6ca] uppercase">
              03 // Cognitive Pipeline
            </span>
          </div>
          <h2 className="font-display text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight text-white uppercase leading-[0.95]">
            THE CAR DOESN'T <br />
            JUST MOVE. <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-[#2ee6ca] to-neutral-400">
              IT DECIDES.
            </span>
          </h2>
          <p className="text-base text-neutral-400 font-light mt-6 max-w-xl">
            From optical photons to physical steering torque, every millisecond is governed by a synchronous five-stage neural decision cycle.
          </p>
        </div>

        {/* 5-Step Horizontal Pipeline Stepper */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-12">
          {steps.map((step) => {
            const Icon = step.icon;
            const isActive = activeStep === step.id;

            return (
              <button
                key={step.id}
                onClick={() => setActiveStep(step.id)}
                className={`relative p-5 rounded-lg text-left transition-all duration-300 border flex flex-col justify-between ${
                  isActive
                    ? 'bg-[#080808]/95 border-[#2ee6ca] shadow-[0_0_30px_rgba(46,230,202,0.2)] -translate-y-1'
                    : 'bg-[#080808]/75 backdrop-blur-xl border-white/[0.08] hover:border-white/20'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <span className={`text-[10px] font-mono tracking-widest uppercase ${
                      isActive ? 'text-[#2ee6ca]' : 'text-neutral-400'
                    }`}>
                      0{step.id + 1}
                    </span>
                    <Icon className={`w-4 h-4 ${
                      isActive ? 'text-[#2ee6ca]' : 'text-neutral-400'
                    }`} />
                  </div>
                  <div className={`font-display text-lg font-bold uppercase tracking-tight ${
                    isActive ? 'text-white' : 'text-neutral-400'
                  }`}>
                    {step.name}
                  </div>
                  <div className="text-[10px] font-mono text-neutral-400 tracking-wider mt-1">
                    {step.tag}
                  </div>
                </div>

                {/* Progress Indicator line */}
                <div className="w-full h-0.5 bg-white/10 rounded-full overflow-hidden mt-6">
                  <div
                    className={`h-full transition-all duration-500 ${
                      isActive ? 'w-full bg-[#2ee6ca]' : 'w-0'
                    }`}
                  />
                </div>
              </button>
            );
          })}
        </div>

        {/* Active Stage Detailed Breakdown Terminal */}
        <div className="rounded-xl bg-[#080808]/85 backdrop-blur-2xl border border-white/10 p-8 sm:p-12 relative overflow-hidden shadow-2xl">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-8 pb-8 border-b border-white/[0.06]">
            <div>
              <div className="flex items-center space-x-3 text-xs font-mono text-[#2ee6ca] uppercase mb-2">
                <Activity className="w-4 h-4 animate-pulse" />
                <span>ACTIVE STAGE: // {steps[activeStep].name}</span>
              </div>
              <h3 className="font-display text-2xl sm:text-3xl font-bold text-white uppercase tracking-tight">
                {steps[activeStep].tag}
              </h3>
            </div>

            <div className="inline-flex items-center space-x-2 px-4 py-2 rounded bg-black/60 border border-white/10 text-xs font-mono text-neutral-300">
              <span className="w-2 h-2 rounded-full bg-[#2ee6ca] animate-ping" />
              <span>STATUS: {steps[activeStep].statusText}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 pt-8">
            <div className="lg:col-span-7 space-y-4">
              <h4 className="text-sm font-mono text-neutral-400 uppercase tracking-wider">
                Operational Overview
              </h4>
              <p className="text-base sm:text-lg text-neutral-200 font-light leading-relaxed">
                {steps[activeStep].summary}
              </p>
            </div>

            <div className="lg:col-span-5 space-y-3">
              <h4 className="text-sm font-mono text-neutral-400 uppercase tracking-wider">
                Telemetry Readout
              </h4>
              <div className="space-y-2">
                {steps[activeStep].metrics.map((metric, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded bg-white/[0.02] border border-white/[0.05] flex items-center justify-between text-xs font-mono text-neutral-300"
                  >
                    <span>METRIC_0{idx + 1}</span>
                    <span className="text-[#2ee6ca] font-medium">{metric}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>

      </div>
    </section>
  );
}
