"use client";
import { Icon, type IconName } from "@/components/icons";
import { togglePaused, useLiveState, type LiveStatus } from "@/lib/liveClient";

const SHOW: Record<Exclude<LiveStatus, "idle">, [string, IconName, string]> = {
  live: ["good", "check", "Live"], connecting: ["", "refresh", "Connecting"], reconnecting: ["warn", "warn", "Reconnecting"], off: ["bad", "warn", "Not live"], paused: ["", "pause", "Paused"],
};

export function LiveControl() {
  const { status, paused, lastAt } = useLiveState();
  if (status === "idle") return null;
  const [tone, icon, label] = SHOW[status];
  const updated = lastAt ? `Updated ${new Date(lastAt).toLocaleTimeString()}. ` : "";
  // Pause and resume live inside the badge: one control that also shows the state
  return <span className="live-control"><button type="button" className={`badge ${tone}`} role="status" aria-label={`${label}. ${paused ? "Resume" : "Pause"} live updates`} title={`${updated}Click to ${paused ? "resume" : "pause"}`} onClick={togglePaused}><Icon name={icon} size={12} />{label}<Icon name={paused ? "play" : "pause"} size={12} /></button></span>;
}
