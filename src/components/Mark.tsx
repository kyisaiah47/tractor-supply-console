// The console's mark: a drive wheel seen side on, lugs around a hub.
export function Mark() {
  const lugs = Array.from({ length: 10 }, (_, i) => i * 36);
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="#12161a" stroke="#7cc4ff" strokeOpacity="0.55" />
      <g transform="translate(12 12)">
        {lugs.map((a) => (
          <rect key={a} x="-1.1" y="-8.6" width="2.2" height="2.6" rx="0.5" fill="#7cc4ff" transform={`rotate(${a})`} />
        ))}
        <circle r="5.2" fill="none" stroke="#e6ebef" strokeWidth="1.4" />
        <circle r="1.9" fill="#7cc4ff" />
      </g>
    </svg>
  );
}
