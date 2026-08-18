interface LogoProps {
  size?: number | 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'icon' | 'full' | 'compact' | 'auth';
  className?: string;
}

export function LogoIcon({ size = 42, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`jl-logo-icon ${className}`}
      aria-label="Javeriya Lubricants"
    >
      <defs>
        <linearGradient id="jlGoldGrad" x1="15%" y1="5%" x2="85%" y2="95%">
          <stop offset="0%" stopColor="#fae28c" />
          <stop offset="35%" stopColor="#e5bc3b" />
          <stop offset="70%" stopColor="#c99718" />
          <stop offset="100%" stopColor="#876008" />
        </linearGradient>
        <linearGradient id="jlGlowGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="50%" stopColor="#fae28c" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id="jlDarkBase" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#1a1815" />
          <stop offset="100%" stopColor="#0c0b0a" />
        </linearGradient>
        <filter id="jlDropShadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000000" floodOpacity="0.35" />
        </filter>
      </defs>

      {/* Outer Rounded Container */}
      <rect
        x="4"
        y="4"
        width="92"
        height="92"
        rx="22"
        fill="url(#jlDarkBase)"
        stroke="url(#jlGoldGrad)"
        strokeWidth="2.5"
        filter="url(#jlDropShadow)"
      />

      {/* Subtle Inner Ring */}
      <circle
        cx="50"
        cy="50"
        r="38"
        stroke="url(#jlGoldGrad)"
        strokeWidth="1"
        strokeDasharray="4 3"
        opacity="0.35"
      />

      {/* Industrial Oil Droplet + JL Monogram Shape */}
      <g transform="translate(0, 1)">
        {/* Outer Droplet Wing (J Shape) */}
        <path
          d="M50 18 C50 18, 30 38, 30 54 C30 65 39 74 50 74 C61 74 70 65 70 54 C70 38 50 18 50 18 Z"
          fill="url(#jlGoldGrad)"
        />

        {/* Inner Oil Cutout / Core */}
        <path
          d="M50 25 C50 25, 36 41, 36 53 C36 61.5 42.5 68 50 68 C57.5 68 64 61.5 64 53 C64 41 50 25 50 25 Z"
          fill="url(#jlDarkBase)"
        />

        {/* Dynamic JL Ribbon / Droplet Flame */}
        <path
          d="M45 35 C45 35 40 45 40 53 C40 58.5 44.5 63 50 63 C52.5 63 54.8 62 56.5 60.5 C54 59.5 52 57 52 54 C52 49 57 44 57 44 C57 44 48 41 45 35 Z"
          fill="url(#jlGoldGrad)"
        />

        {/* Highlight Reflection */}
        <ellipse
          cx="43"
          cy="46"
          rx="3"
          ry="7"
          transform="rotate(-25 43 46)"
          fill="#ffffff"
          opacity="0.45"
        />

        {/* Bottom Gold Accent Dot */}
        <circle cx="50" cy="53" r="2.5" fill="#ffffff" opacity="0.8" />
      </g>
    </svg>
  );
}

export function Logo({ size = 'md', variant = 'full', className = '' }: LogoProps) {
  const pixelSize =
    typeof size === 'number'
      ? size
      : size === 'sm'
        ? 34
        : size === 'md'
          ? 44
          : size === 'lg'
            ? 58
            : 76;

  if (variant === 'icon') {
    return <LogoIcon size={pixelSize} className={className} />;
  }

  if (variant === 'auth') {
    return (
      <div className={`jl-auth-brand ${className}`}>
        <LogoIcon size={64} />
        <div className="jl-auth-brand-text">
          <div className="jl-brand-name">JAVERIYA</div>
          <div className="jl-brand-sub">LUBRICANTS ERP</div>
        </div>
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <div className={`jl-logo-compact ${className}`}>
        <LogoIcon size={pixelSize} />
        <div className="jl-brand-text">
          <span className="jl-brand-name-compact">Javeriya</span>
          <span className="jl-brand-sub-compact">Lubricants ERP</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`jl-logo-full ${className}`}>
      <LogoIcon size={pixelSize} />
      <div className="jl-brand-text">
        <strong className="jl-title">Javeriya Lubricants</strong>
        <small className="jl-subtitle">Enterprise Resource Planning</small>
      </div>
    </div>
  );
}
