"use client";

import { useEffect, useRef, useState } from "react";
import { Brain, Send, RefreshCw, Lock, Ban, Sliders, Mic } from "lucide-react";

// Minimal typing for the browser SpeechRecognition API (not in lib.dom defaults).
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ConstraintUpdate {
  action: "regenerate" | "info";
  locked_players?: string[];
  excluded_players?: string[];
  lambda?: number;
  exposure_cap?: number;
  contest_type?: "cash" | "gpp";
}

export interface ChatLineupPlayer {
  dk_name: string;
  position: string;
  slot?: string | null;
  salary: number;
  projection: number;
  team: string;
}

export interface ChatLineup {
  players: ChatLineupPlayer[];
  total_salary: number;
  projected_score: number;
  salary_cap: number;
}

export interface ChatConstraints {
  contest_type: "cash" | "gpp";
  locked_players: string[];
  excluded_players: string[];
  lambda: number;
  exposure_cap: number;
}

// A short, human-readable summary of what an action block changes.
function summarizeUpdate(u: ConstraintUpdate): string[] {
  const parts: string[] = [];
  if (u.locked_players) parts.push(`lock ${u.locked_players.length}`);
  if (u.excluded_players) parts.push(`exclude ${u.excluded_players.length}`);
  if (typeof u.lambda === "number") parts.push(`λ ${u.lambda.toFixed(2)}`);
  if (typeof u.exposure_cap === "number") parts.push(`exp ${Math.round(u.exposure_cap * 100)}%`);
  if (u.contest_type) parts.push(u.contest_type.toUpperCase());
  return parts;
}

export function AIChatPanel({
  date,
  lineup,
  constraints,
  onApply,
  rebuilding,
}: {
  date: string;
  lineup: ChatLineup | null;
  constraints: ChatConstraints;
  // Apply the constraint block to page state; the page handles the rebuild.
  onApply: (u: ConstraintUpdate) => void;
  rebuilding: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [sttSupported, setSttSupported] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Text already committed to the input when dictation started, so we append
  // the transcript rather than clobbering anything the user typed by hand.
  const baseInputRef = useRef("");

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Wire up the browser SpeechRecognition once; degrade silently if absent.
  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      const base = baseInputRef.current;
      setInput((base ? base + " " : "") + transcript);
    };
    rec.onerror = (e) => {
      setListening(false);
      if (e.error !== "aborted" && e.error !== "no-speech") {
        setError(e.error === "not-allowed" ? "Microphone permission denied." : `Voice input error: ${e.error}`);
      }
    };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setSttSupported(true);
    return () => { try { rec.stop(); } catch { /* noop */ } };
  }, []);

  function toggleListening() {
    const rec = recognitionRef.current;
    if (!rec) return;
    if (listening) {
      rec.stop();
      setListening(false);
      return;
    }
    setError(null);
    baseInputRef.current = input.trim();
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws if already running; reset state so the next tap works.
      setListening(false);
    }
  }

  async function send() {
    const msg = input.trim();
    if (!msg || loading) return;
    if (listening) { try { recognitionRef.current?.stop(); } catch { /* noop */ } setListening(false); }
    setError(null);
    const history = messages;
    setMessages([...history, { role: "user", content: msg }]);
    setInput("");
    setLoading(true);
    try {
      const resp = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          history,
          current_lineup: lineup,
          current_constraints: constraints,
          date,
        }),
      });
      const j = await resp.json();
      if (!resp.ok || j.error) {
        setError(j.error || "Chat request failed.");
        return;
      }
      const text: string = j.response || "";
      const update: ConstraintUpdate | null = j.constraint_update ?? null;
      setMessages((prev) => [...prev, { role: "assistant", content: text }]);
      if (update && update.action === "regenerate") {
        onApply(update);
      }
    } catch (err) {
      setError(`Chat failed: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  // Pull the latest assistant action block (if any) for the apply banner.
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
        <Brain size={15} className="text-[var(--accent-blue-bright)]" />
        <h3 className="text-xs font-semibold">AI Assistant</h3>
        <span className="text-[10px] font-mono text-[var(--muted)] ml-auto">Claude Sonnet</span>
      </div>

      <div ref={scrollRef} className="px-3 py-3 space-y-3 overflow-y-auto max-h-[420px] min-h-[140px]">
        {messages.length === 0 && !loading ? (
          <div className="text-[11px] text-[var(--muted)] leading-relaxed">
            Ask me to refine the lineup — e.g. &ldquo;lock Skenes and stack the Dodgers&rdquo;,
            &ldquo;drop the chalk and raise variance&rdquo;, or &ldquo;why is Witt in here?&rdquo;
            I&apos;ll explain the call and rebuild when you want a change.
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[85%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed bg-[var(--accent-blue)]/20 text-zinc-100"
                  : "max-w-[90%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed bg-[var(--surface-2)] text-zinc-200 whitespace-pre-wrap"
              }
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading ? (
          <div className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
            <div className="w-3.5 h-3.5 border-2 border-[var(--accent-blue)]/40 border-t-[var(--accent-blue-bright)] rounded-full animate-spin" />
            Thinking…
          </div>
        ) : null}
        {rebuilding ? (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--accent-blue-bright)]">
            <RefreshCw size={12} className="animate-spin" />
            Rebuilding lineup with new constraints…
          </div>
        ) : null}
        {error ? <div className="text-[11px] text-red-400">{error}</div> : null}
      </div>

      {/* Current constraint readout — what the assistant is steering. */}
      <div className="px-3 py-1.5 border-t border-[var(--border)] flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-mono text-[var(--muted)]">
        <span className="inline-flex items-center gap-1"><Sliders size={10} />{constraints.contest_type.toUpperCase()}</span>
        <span className="inline-flex items-center gap-1"><Lock size={10} />{constraints.locked_players.length}</span>
        <span className="inline-flex items-center gap-1"><Ban size={10} />{constraints.excluded_players.length}</span>
        <span>λ {constraints.lambda.toFixed(2)}</span>
        <span>exp {Math.round(constraints.exposure_cap * 100)}%</span>
      </div>

      <div className="px-2.5 py-2 border-t border-[var(--border)] flex items-center gap-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={listening ? "Listening…" : "Refine the lineup…"}
          disabled={loading}
          className="flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border)] rounded px-2.5 py-1.5 text-[11px] focus:outline-none focus:border-[var(--accent-blue)] disabled:opacity-50"
        />
        {sttSupported ? (
          <button
            onClick={toggleListening}
            disabled={loading}
            className={
              listening
                ? "px-2.5 py-1.5 bg-red-500/90 text-white rounded text-xs font-semibold hover:bg-red-500 disabled:opacity-50 flex items-center justify-center animate-pulse"
                : "px-2.5 py-1.5 bg-[var(--surface-2)] border border-[var(--border)] text-[var(--muted)] rounded text-xs font-semibold hover:text-zinc-100 hover:border-[var(--accent-blue)] disabled:opacity-50 flex items-center justify-center"
            }
            aria-label={listening ? "Stop voice input" : "Start voice input"}
            title={listening ? "Stop voice input" : "Voice input"}
          >
            <Mic size={13} />
          </button>
        ) : null}
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="px-2.5 py-1.5 bg-[var(--accent-blue)] text-black rounded text-xs font-semibold hover:bg-[var(--accent-blue-bright)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          aria-label="Send"
        >
          <Send size={13} />
        </button>
      </div>
    </div>
  );
}

export { summarizeUpdate };
