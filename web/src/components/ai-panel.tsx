"use client";

import { useState } from "react";
import { Brain, Shield, TrendingUp, AlertTriangle, CheckCircle, RefreshCw, Send } from "lucide-react";

interface AIAnalysis {
  summary?: string;
  top_plays?: string[];
  risks?: string[];
  suggested_adjustments?: string[];
  confidence?: string;
}

interface Lineup {
  lineup_num: number;
  players: { dk_name: string; player_name?: string; position: string; salary: number; projection: number; team: string; sim_exposure?: number }[];
  total_salary: number;
  projected_score: number;
}

export function AIPanel({
  analysis,
  source,
  loading,
  onApplySuggestion,
}: {
  analysis: AIAnalysis | null;
  source: string;
  loading: boolean;
  onApplySuggestion: (text: string) => void;
}) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
        <Brain size={16} className="text-[var(--accent-blue-bright)]" />
        <h3 className="text-sm font-semibold">AI Analysis</h3>
        {source && (
          <span className="text-[10px] font-mono text-[var(--muted)] ml-auto">
            {source.includes("claude") ? "Claude Sonnet" : source === "rule-based" ? "Rule-based" : source}
          </span>
        )}
      </div>
      <div className="p-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <div className="w-4 h-4 border-2 border-[var(--accent-blue)]/40 border-t-[var(--accent-blue-bright)] rounded-full animate-spin" />
            Analyzing lineups with Claude...
          </div>
        ) : analysis ? (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed">{analysis.summary}</p>

            {analysis.confidence && (
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                  analysis.confidence === "high"
                    ? "bg-[var(--success)]/20 text-[var(--success)]"
                    : analysis.confidence === "medium"
                    ? "bg-[var(--warning)]/20 text-[var(--warning)]"
                    : "bg-[var(--danger)]/20 text-[var(--danger)]"
                }`}>
                  <Shield size={10} />
                  {analysis.confidence} confidence
                </span>
              </div>
            )}

            {analysis.top_plays && analysis.top_plays.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <TrendingUp size={12} className="text-[var(--success)]" />
                  <span className="text-xs font-semibold text-[var(--success)]">Top Plays</span>
                </div>
                {analysis.top_plays.map((play, i) => (
                  <p key={i} className="text-xs text-[var(--muted)] ml-5 mb-1">{play}</p>
                ))}
              </div>
            )}

            {analysis.risks && analysis.risks.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <AlertTriangle size={12} className="text-[var(--warning)]" />
                  <span className="text-xs font-semibold text-[var(--warning)]">Risks</span>
                </div>
                {analysis.risks.map((risk, i) => (
                  <p key={i} className="text-xs text-[var(--muted)] ml-5 mb-1">{risk}</p>
                ))}
              </div>
            )}

            {analysis.suggested_adjustments && analysis.suggested_adjustments.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <CheckCircle size={12} className="text-[var(--accent-blue-bright)]" />
                  <span className="text-xs font-semibold text-[var(--accent-blue-bright)]">Suggestions</span>
                  <span className="text-[9px] text-[var(--muted)]">(click to apply)</span>
                </div>
                {analysis.suggested_adjustments.map((adj, i) => (
                  <button
                    key={i}
                    onClick={() => onApplySuggestion(adj)}
                    className="block text-left text-xs text-[var(--accent-blue-bright)] hover:text-[var(--foreground)] ml-5 mb-1.5 cursor-pointer underline decoration-[var(--accent-blue)]/30 hover:decoration-[var(--accent-blue-bright)] transition-colors"
                  >
                    {adj}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-[var(--muted)]">
            AI analysis will appear here after generating lineups.
          </p>
        )}
      </div>
    </div>
  );
}

export function RegenPanel({
  onRegenerate,
  loading,
  reasoning,
}: {
  onRegenerate: (instructions: string) => void;
  loading: boolean;
  reasoning: string | null;
}) {
  const [instructions, setInstructions] = useState("");

  const handleSubmit = () => {
    if (instructions.trim()) {
      onRegenerate(instructions.trim());
      setInstructions("");
    }
  };

  return (
    <div className="bg-[var(--surface)] border border-[var(--accent-blue)]/30 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <RefreshCw size={14} className="text-[var(--accent-blue-bright)]" />
        <h3 className="text-sm font-semibold">Regenerate with Instructions</h3>
      </div>
      <p className="text-xs text-[var(--muted)] mb-3">
        Tell the AI what to change: &quot;exclude Muncy&quot;, &quot;stack LAD bats&quot;, &quot;more upside&quot;, &quot;lock Ohtani&quot;, &quot;safer pitchers&quot;
      </p>
      <div className="flex gap-2">
        <input
          id="regen-input"
          type="text"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && instructions.trim()) handleSubmit();
          }}
          placeholder="e.g., exclude Willi Castro and lock Ohtani"
          className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--muted)]/50 focus:border-[var(--accent-blue)] focus:outline-none"
        />
        <button
          onClick={handleSubmit}
          disabled={loading || !instructions.trim()}
          className="flex items-center gap-2 bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {loading ? (
            <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          ) : (
            <Send size={14} />
          )}
          {loading ? "Rebuilding..." : "Regenerate"}
        </button>
      </div>
      {reasoning && (
        <p className="text-xs text-[var(--accent-blue-bright)] mt-2 flex items-center gap-1.5">
          <Brain size={11} />
          {reasoning}
        </p>
      )}
    </div>
  );
}

export function setRegenInput(text: string) {
  const el = document.getElementById("regen-input") as HTMLInputElement | null;
  if (el) {
    // Trigger React's onChange by setting nativeInputValueSetter
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.focus();
  }
}
