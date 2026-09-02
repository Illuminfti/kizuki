/** The packet's sections, in the order they are packed and rendered. */
export const PACKET_SECTIONS = ["canon", "graph", "timeline"] as const;
export type PacketSection = (typeof PACKET_SECTIONS)[number];
