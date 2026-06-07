// Inline SVG icons (Lucide-inspired, custom stroke). 16px default, 1.5px stroke.
// NOTE: no `...rest` here on purpose. Babel-standalone compiles every
// <script type="text/babel"> in the same global scope, and each file that uses
// `...rest` destructuring emits its own `var _excluded = [...]`. The last
// declaration wins, so a later file's _excluded (e.g. ["breakdown"]) was
// overwriting ours and leaking `size`/`stroke`/`style` through to the <svg>,
// which clobbered `stroke="currentColor"` and made every sidebar icon vanish.
const Icon = ({ d, size = 16, stroke = 1.5, fill, children, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill || "none"}
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0, color: "var(--fg-2)", ...style }}
  >
    {d ? <path d={d} /> : children}
  </svg>
);

const I = {
  Dashboard: (p) => (
    <Icon {...p}>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="5" rx="1" />
      <rect x="13" y="10" width="8" height="11" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
    </Icon>
  ),
  Stock: (p) => (
    <Icon {...p}>
      <path d="M3 7 L12 3 L21 7 L12 11 Z" />
      <path d="M3 7 V17 L12 21 L21 17 V7" />
      <path d="M12 11 V21" />
      <path d="M7.5 5 L16.5 9" />
    </Icon>
  ),
  Recipe: (p) => (
    <Icon {...p}>
      <path d="M6 3 H17 L20 6 V21 H6 Z" />
      <path d="M17 3 V6 H20" />
      <path d="M9 10 H15 M9 13 H15 M9 16 H13" />
    </Icon>
  ),
  Revenue: (p) => (
    <Icon {...p}>
      <path d="M12 3 V21" />
      <path d="M16 7 H10 a2.5 2.5 0 0 0 0 5 H14 a2.5 2.5 0 0 1 0 5 H7" />
    </Icon>
  ),
  Request: (p) => (
    <Icon {...p}>
      <path d="M3 4 H6 L8 7 H20 L18 15 H9" />
      <path d="M9 18 H18" />
      <circle cx="10" cy="20.5" r="1.3" />
      <circle cx="17" cy="20.5" r="1.3" />
    </Icon>
  ),
  ShoppingList: (p) => (
    <Icon {...p}>
      <path d="M8 4 a4 4 0 0 1 8 0" />
      <path d="M5 7 H19 L18 21 H6 Z" />
      <path d="M9 12 V16 M15 12 V16" />
    </Icon>
  ),
  CMV: (p) => (
    <Icon {...p}>
      <path d="M3 20 L9 14 L13 18 L21 9" />
      <path d="M15 9 H21 V15" />
      <circle cx="9" cy="14" r="1" fill="currentColor" />
      <circle cx="13" cy="18" r="1" fill="currentColor" />
    </Icon>
  ),
  Finance: (p) => (
    <Icon {...p}>
      <path d="M12 3 a9 9 0 1 0 9 9 H12 Z" />
      <path d="M14 3 a8 8 0 0 1 7 7 H14 Z" />
    </Icon>
  ),
  Settings: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2 V5 M12 19 V22 M22 12 H19 M5 12 H2 M19 5 L17 7 M7 17 L5 19 M19 19 L17 17 M7 7 L5 5" />
    </Icon>
  ),
  Search: (p) => (
    <Icon {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16 16 L21 21" />
    </Icon>
  ),
  Chevron: (p) => (
    <Icon {...p}>
      <path d="M6 9 L12 15 L18 9" />
    </Icon>
  ),
  ChevronR: (p) => (
    <Icon {...p}>
      <path d="M9 6 L15 12 L9 18" />
    </Icon>
  ),
  PanelLeft: (p) => (
    <Icon {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4 V20" />
    </Icon>
  ),
  Plus: (p) => (
    <Icon {...p}>
      <path d="M12 5 V19 M5 12 H19" />
    </Icon>
  ),
  Filter: (p) => (
    <Icon {...p}>
      <path d="M3 5 H21 L14 13 V20 L10 18 V13 Z" />
    </Icon>
  ),
  Bell: (p) => (
    <Icon {...p}>
      <path d="M6 8 a6 6 0 0 1 12 0 v5 l2 3 H4 l2 -3 Z" />
      <path d="M10 19 a2 2 0 0 0 4 0" />
    </Icon>
  ),
  Sun: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2 V4 M12 20 V22 M2 12 H4 M20 12 H22 M5 5 L6.5 6.5 M17.5 17.5 L19 19 M19 5 L17.5 6.5 M6.5 17.5 L5 19" />
    </Icon>
  ),
  Moon: (p) => (
    <Icon {...p}>
      <path d="M21 13 a9 9 0 1 1 -10 -10 a7 7 0 0 0 10 10 Z" />
    </Icon>
  ),
  ArrowUp: (p) => (
    <Icon {...p}>
      <path d="M12 19 V5 M5 12 L12 5 L19 12" />
    </Icon>
  ),
  ArrowDown: (p) => (
    <Icon {...p}>
      <path d="M12 5 V19 M5 12 L12 19 L19 12" />
    </Icon>
  ),
  ArrowRight: (p) => (
    <Icon {...p}>
      <path d="M5 12 H19 M12 5 L19 12 L12 19" />
    </Icon>
  ),
  Check: (p) => (
    <Icon {...p}>
      <path d="M4 12 L10 18 L20 6" />
    </Icon>
  ),
  X: (p) => (
    <Icon {...p}>
      <path d="M5 5 L19 19 M19 5 L5 19" />
    </Icon>
  ),
  Box: (p) => (
    <Icon {...p}>
      <path d="M3 7 L12 3 L21 7 V17 L12 21 L3 17 Z" />
      <path d="M3 7 L12 11 L21 7 M12 11 V21" />
    </Icon>
  ),
  Truck: (p) => (
    <Icon {...p}>
      <rect x="2" y="7" width="11" height="10" />
      <path d="M13 10 H17 L21 14 V17 H13" />
      <circle cx="6" cy="19" r="1.5" />
      <circle cx="17" cy="19" r="1.5" />
    </Icon>
  ),
  WhatsApp: (p) => (
    <Icon {...p}>
      <path d="M3 21 L4.5 16 A8 8 0 1 1 8 19.5 Z" />
      <path d="M9 11 c1 2 2 3 4 4 l1 -1 l2 1 v2 c-3 0 -7 -3 -7 -7 h2 l1 2 z" />
    </Icon>
  ),
  AlertTriangle: (p) => (
    <Icon {...p}>
      <path d="M12 4 L22 20 H2 Z" />
      <path d="M12 10 V14 M12 17 V17.5" />
    </Icon>
  ),
  Calendar: (p) => (
    <Icon {...p}>
      <rect x="3" y="5" width="18" height="16" rx="1" />
      <path d="M3 10 H21 M8 3 V7 M16 3 V7" />
    </Icon>
  ),
  More: (p) => (
    <Icon {...p}>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" />
    </Icon>
  ),
  Command: (p) => (
    <Icon {...p}>
      <path d="M9 6 a2 2 0 1 0 -2 2 H17 a2 2 0 1 0 -2 -2 V18 a2 2 0 1 0 2 -2 H7 a2 2 0 1 0 2 2 Z" />
    </Icon>
  ),
  Edit: (p) => (
    <Icon {...p}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
    </Icon>
  ),
  Print: (p) => (
    <Icon {...p}>
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </Icon>
  ),
  Eye: (p) => (
    <Icon {...p}>
      <path d="M2 12 C5 6 9 4 12 4 C15 4 19 6 22 12 C19 18 15 20 12 20 C9 20 5 18 2 12 Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  ),
  Trash: (p) => (
    <Icon {...p}>
      <path d="M4 7 H20 M9 7 V4 H15 V7 M6 7 L7 20 H17 L18 7 M10 11 V17 M14 11 V17" />
    </Icon>
  ),
  Lock: (p) => (
    <Icon {...p}>
      <rect x="5" y="11" width="14" height="9" rx="1" />
      <path d="M8 11 V8 a4 4 0 0 1 8 0 V11" />
    </Icon>
  ),
  Camera: (p) => (
    <Icon {...p}>
      <path d="M3 8 H6 L8 5 H16 L18 8 H21 V19 H3 Z" />
      <circle cx="12" cy="13" r="3.5" />
    </Icon>
  ),
  Pen: (p) => (
    <Icon {...p}>
      <path d="M3 21 L7 20 L20 7 L17 4 L4 17 Z" />
    </Icon>
  ),
  Clock: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7 V12 L15 14" />
    </Icon>
  ),
  User: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21 V19 a6 6 0 0 1 16 0 V21" />
    </Icon>
  ),
  Trophy: (p) => (
    <Icon {...p}>
      <path d="M7 4 H17 V8 a5 5 0 0 1 -10 0 Z" />
      <path d="M5 6 H3 V8 a3 3 0 0 0 4 3 M19 6 H21 V8 a3 3 0 0 1 -4 3" />
      <path d="M9 13 V16 H15 V13 M8 19 H16 L15 16 H9 Z" />
    </Icon>
  ),
  Play: (p) => (
    <Icon {...p}>
      <path d="M7 4 V20 L20 12 Z" fill="currentColor" />
    </Icon>
  ),
  MapPin: (p) => (
    <Icon {...p}>
      <path d="M12 22 C8 16 5 13 5 9 a7 7 0 0 1 14 0 c0 4 -3 7 -7 13 Z" />
      <circle cx="12" cy="9" r="2.5" />
    </Icon>
  ),
};

window.I = I;
