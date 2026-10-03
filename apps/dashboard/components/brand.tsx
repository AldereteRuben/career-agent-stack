/** Three steps share one baseline: a compact mark for steady career progress. */
export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M9 28V23M20 28V16M31 28V9" stroke="currentColor" strokeWidth="6" strokeLinecap="round"/></svg></span>;
}

export function Brand() {
  return <><BrandMark/><span className="brand-wordmark">Career <span>Stack</span></span></>;
}
