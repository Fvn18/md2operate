/**
 * web/src/components/Icons.tsx — 内联 SVG 图标集。
 * 手写而不是引图标库：本工作台只用到二十来个图标，内联后是零依赖、零请求、
 * 且完全跟随 CSS 变量着色（currentColor）。
 */

import React from 'react';

const P: Record<string, React.ReactNode> = {
  file: <><path d="M14 3v5h5" /><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M4 17l4.5-4.5L13 17l3-3 4 4" /></>,
  code: <><path d="M9 18l-5-6 5-6" /><path d="M15 6l5 6-5 6" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" /></>,
  word: <><path d="M6 3h9l5 5v13H6z" /><path d="M9 12l1.6 5L12 13l1.4 4L15 12" /></>,
  download: <><path d="M12 4v11" /><path d="M7.5 11.5L12 16l4.5-4.5" /><path d="M5 19h14" /></>,
  upload: <><path d="M12 20V9" /><path d="M7.5 12.5L12 8l4.5 4.5" /><path d="M5 4h14" /></>,
  play: <><path d="M7 4.5l12 7.5-12 7.5z" /></>,
  loader: <><path d="M12 3v4" /><path d="M12 17v4" /><path d="M3 12h4" /><path d="M17 12h4" /><path d="M5.6 5.6l2.8 2.8" /><path d="M15.6 15.6l2.8 2.8" /><path d="M18.4 5.6l-2.8 2.8" /><path d="M8.4 15.6l-2.8 2.8" /></>,
  x: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  sliders: <><path d="M4 6h10" /><path d="M18 6h2" /><path d="M4 12h4" /><path d="M12 12h8" /><path d="M4 18h12" /><path d="M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3" /><path d="M12.5 15H17" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
  moon: <><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></>,
  palette: <><path d="M12 21a9 9 0 1 1 0-18c4.5 0 8 3 8 6.5 0 2.5-2 3.5-4 3.5h-1.5a2 2 0 0 0-1.4 3.4A1.9 1.9 0 0 1 12 21z" /><circle cx="8" cy="10" r="1" /><circle cx="12" cy="7.5" r="1" /><circle cx="16" cy="10" r="1" /></>,
  book: <><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" /><path d="M8 3v18" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>,
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  check: <><path d="M5 12.5l4.5 4.5L19 7" /></>,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4" /><circle cx="12" cy="17" r="0.6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7.8" r="0.7" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></>,
  eye: <><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.7" /></>,
  eyeOff: <><path d="M3 3l18 18" /><path d="M10.6 6.1A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.5 4.3" /><path d="M6.3 7.8A16.4 16.4 0 0 0 2 12s3.6 6.5 10 6.5c1.4 0 2.6-.3 3.7-.8" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9.5 4v16" /></>,
  panelRight: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14.5 4v16" /></>,
  panelBottom: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14.5h18" /></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h0M9.5 10h0M13 10h0M16.5 10h0M6 14h12" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M15.5 15.5L21 21" /></>,
  save: <><path d="M5 4h11l4 4v12H5z" /><path d="M9 4v6h7V4" /><path d="M8 20v-6h8v6" /></>,
  wand: <><path d="M4 20l9-9" /><path d="M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" /><path d="M19 12l.7 1.4 1.3.6-1.3.6L19 16l-.7-1.4-1.3-.6 1.3-.6z" /></>,
  layers: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  package: <><path d="M12 3l9 5v8l-9 5-9-5V8z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" /></>,
  activity: <><path d="M3 12h4l3 7 4-14 3 7h4" /></>,
  chevronDown: <><path d="M6 9l6 6 6-6" /></>,
  chevronRight: <><path d="M9 6l6 6-6 6" /></>,
  hash: <><path d="M9 3l-2 18M17 3l-2 18M4 9h16M3 15h16" /></>,
  type: <><path d="M4 6V4h16v2" /><path d="M12 4v16" /><path d="M9 20h6" /></>,
  ruler: <><rect x="2" y="8" width="20" height="8" rx="1.5" /><path d="M6 8v3M10 8v4M14 8v3M18 8v4" /></>,
  crop: <><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M2 6h14a2 2 0 0 1 2 2v14" /></>,
  maximize: <><path d="M4 9V4h5" /><path d="M20 15v5h-5" /><path d="M15 4h5v5" /><path d="M9 20H4v-5" /></>,
  zap: <><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.5l3.5 2" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4.5l3 1.8" /></>,
  split: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>,
  sparkle: <><path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z" /></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 15, className, strokeWidth = 1.7 }: {
  name: IconName | string; size?: number; className?: string; strokeWidth?: number;
}) {
  const node = P[name] || P.info;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true" focusable="false"
    >
      {node}
    </svg>
  );
}

export default Icon;
