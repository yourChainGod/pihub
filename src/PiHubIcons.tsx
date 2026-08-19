import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 24, children, ...props }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>{children}</svg>;
}

const line = { stroke: "currentColor", strokeWidth: 1.65, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function PiHubDeviceIcon({ os, size = 26, ...props }: IconProps & { os?: string }) {
  const value = os?.toLowerCase() || "linux";
  if (value.includes("mac")) return <Icon size={size} {...props}><rect x="4" y="4" width="16" height="11" rx="1.8" {...line} /><path d="M2.8 18h18.4M9 18l-.8 2h7.6l-.8-2" {...line} /><path d="M12 2.3c.7 0 1.3.3 1.7.8" {...line} /></Icon>;
  if (value.includes("windows")) return <Icon size={size} {...props}><path d="m3.5 4.5 7.7-1.1v8H3.5v-6.9ZM12.7 3.2l7.8-1v9.2h-7.8V3.2ZM3.5 12.9h7.7v7.8l-7.7-1.1v-6.7ZM12.7 12.9h7.8v8.9l-7.8-1.1v-7.8Z" fill="currentColor" opacity=".9" /></Icon>;
  if (value.includes("rasp") || value.includes("pi")) return <Icon size={size} {...props}><rect x="5" y="3.5" width="14" height="17" rx="2.4" {...line} /><path d="M8 7h8M8 11h8M8 15h3" {...line} /><circle cx="15.5" cy="16" r="1.2" fill="currentColor" /></Icon>;
  return <Icon size={size} {...props}><rect x="3.5" y="5" width="17" height="13.5" rx="2" {...line} /><path d="M7 9h2M11 9h2M15 9h2M7 13h5M15 13h2M8 18.5v2M16 18.5v2" {...line} /><circle cx="18" cy="7" r="1" fill="currentColor" /></Icon>;
}

export function PiHubTailnetIcon({ size = 22, ...props }: IconProps) {
  return <Icon size={size} {...props}><circle cx="6" cy="12" r="2.6" fill="#55C7A5" /><circle cx="18" cy="6" r="2.6" fill="#64A9FF" /><circle cx="18" cy="18" r="2.6" fill="#B885F4" /><path d="m8.4 10.8 7.2-3.6M8.4 13.2l7.2 3.6" {...line} /><circle cx="12" cy="12" r="2.1" fill="#FA6F46" /></Icon>;
}

export function PiHubServeIcon({ size = 22, ...props }: IconProps) {
  return <Icon size={size} {...props}><path d="M4 8.5h16M6.5 4.5h11A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18V6a1.5 1.5 0 0 1 1.5-1.5Z" {...line} /><circle cx="7.5" cy="6.5" r=".7" fill="#FA6F46" /><path d="m9 14 2 2 4-4" {...line} /></Icon>;
}

export function PiHubSshIcon({ size = 22, ...props }: IconProps) {
  return <Icon size={size} {...props}><rect x="3.5" y="4.5" width="17" height="15" rx="2" {...line} /><path d="m7 10 2 2-2 2M11 14h4" {...line} /><circle cx="17.5" cy="7.5" r="1" fill="#FA6F46" /></Icon>;
}

export function PiHubProviderIcon({ size = 22, ...props }: IconProps) {
  return <Icon size={size} {...props}><path d="M12 3.2 19 7v8l-7 3.8L5 15V7l7-3.8Z" {...line} /><path d="m8.5 9.2 3.5 2 3.5-2M12 11.2v4.3" {...line} /><circle cx="12" cy="3.2" r="1.2" fill="#FA6F46" /></Icon>;
}

export function PiHubContextIcon({ size = 22, ...props }: IconProps) {
  return <Icon size={size} {...props}><circle cx="12" cy="12" r="7.5" {...line} /><path d="M12 7.5v4.8l3 1.8M4.9 7.2 3.7 5.8M19.1 7.2l1.2-1.4M4.9 16.8l-1.2 1.4M19.1 16.8l1.2 1.4" {...line} /><circle cx="12" cy="12" r="1.2" fill="#FA6F46" /></Icon>;
}

export function PiHubFolderIcon({ size = 22, ...props }: IconProps) {
  return <Icon size={size} {...props}><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3l1.8 2h7.2A2.5 2.5 0 0 1 20.5 9v7.5A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z" {...line} /><path d="M3.8 9h16.4" {...line} /><path d="M12 11v5M9.5 13.5h5" {...line} /></Icon>;
}

export function PiHubSessionIcon({ size = 22, ...props }: IconProps) {
  return <Icon size={size} {...props}><rect x="3.5" y="4.5" width="17" height="15" rx="2" {...line} /><path d="M7 8h10M7 12h6M7 16h3" {...line} /><circle cx="17" cy="15.8" r="2.2" fill="#FA6F46" /></Icon>;
}

export function PiHubOnlineIcon({ size = 14, ...props }: IconProps) {
  return <Icon size={size} {...props}><circle cx="12" cy="12" r="3.2" fill="#55C7A5" /><circle cx="12" cy="12" r="6.8" stroke="#55C7A5" strokeOpacity=".28" strokeWidth="1.5" /></Icon>;
}
