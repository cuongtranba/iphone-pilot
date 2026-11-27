export type Mode = "ocr" | "iph";

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Element {
  ref: string;
  role: string;
  label: string;
  value?: string;
  frame: Frame;
  source: "ax" | "ocr";
}

export interface Snapshot {
  mode: Mode;
  screen: { w: number; h: number };
  elements: Element[];
}

export interface OutcomeError {
  code: string;
  message: string;
  hint?: string;
  user_action?: string;
  candidates?: Element[];
}

export interface Outcome {
  ok: boolean;
  outcome: "done" | "not_sent" | "unknown";
  screen_changed?: boolean;
  error?: OutcomeError;
  [extra: string]: unknown;
}

export type Direction = "up" | "down" | "left" | "right";
export type Target = string | { x: number; y: number };

export interface Check {
  check: string;
  ok: boolean;
  detail?: string;
  user_action?: string;
}

export interface ModeReport {
  ready: boolean;
  checks: Check[];
}

export interface DoctorReport {
  mode: Mode;
  ready: boolean;
  modes: { ocr: ModeReport; iph: ModeReport };
}

/** What every driver implements; `Pilot` adds ref persistence on top. */
export interface Driver {
  readonly mode: Mode;
  doctor(): Promise<ModeReport>;
  /** Raw read of the current screen. Refs are assigned by the pilot. */
  read(): Promise<{ screen: { w: number; h: number }; elements: DriverElement[] }>;
  /** `fresh` = the element came from a read made just now, so no re-confirmation is needed. */
  tapElement(el: DriverElement, opts: { fresh: boolean }): Promise<Outcome>;
  tapPoint(x: number, y: number): Promise<Outcome>;
  type(text: string, opts: { submit?: boolean }): Promise<Outcome>;
  key(name: string): Promise<Outcome>;
  swipe(dir: Direction): Promise<Outcome>;
  scroll(dir: "up" | "down"): Promise<Outcome>;
  home(): Promise<Outcome>;
  screenshot(path: string): Promise<Outcome>;
}

/** An element as a driver reports it; `native` is driver-private data persisted with the snapshot. */
export type DriverElement = Omit<Element, "ref"> & { native?: string };

export const KEY_NAMES = ["return", "escape", "tab", "delete", "up", "down", "left", "right", "space"] as const;

export function notSent(code: string, message: string, extra: Partial<OutcomeError> = {}): Outcome {
  return { ok: false, outcome: "not_sent", error: { code, message, ...extra } };
}

/** A read (snapshot) that could not be made; carries the not_sent Outcome to report. */
export class ReadError extends Error {
  constructor(public readonly outcome: Outcome) {
    super(outcome.error?.message ?? "read failed");
  }
}
