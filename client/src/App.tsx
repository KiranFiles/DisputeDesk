import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, Clock3, FileCheck2, History, Inbox, LoaderCircle, MessageSquare, RefreshCw, Search, ShieldCheck, Sparkles, TriangleAlert, Undo2, X } from "lucide-react";
import { api, type ActionBody, type AuditEntry, type DisputeDetail, type DisputeSummary, type Health, type Triage, type TriageResult } from "./api";

const money = (amount?: { currency_code: string; value: string }) =>
  amount ? new Intl.NumberFormat("en-US", { style: "currency", currency: amount.currency_code }).format(Number(amount.value)) : "Not available";
const label = (value: string) => value.replace(/_/g, " ").toLowerCase().replace(/^\w/, (character) => character.toUpperCase());
const daysLeft = (iso?: string) => iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : null;
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const reason = (value: string) => ({ MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item or service not received", MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Item not as described", UNAUTHORISED: "Unauthorized payment", CREDIT_NOT_PROCESSED: "Refund not received" }[value] ?? label(value));
const deadline = (days: number | null) => days === null ? "No deadline supplied" : days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Due today" : `${days}d to respond`;
const ACTIONS = [
  { key: "SEND_MESSAGE", title: "Message buyer", cta: "Send message", icon: MessageSquare },
  { key: "PROVIDE_EVIDENCE", title: "Submit evidence", cta: "Submit evidence", icon: FileCheck2 },
  { key: "ACCEPT_CLAIM", title: "Accept claim", cta: "Accept claim & refund", icon: Undo2 },
] as const;

function Status({ status }: { status: string }) {
  return <span className={`status ${status === "RESOLVED" ? "positive" : status === "WAITING_FOR_SELLER_RESPONSE" ? "attention" : "neutral"}`}><span className="status-dot" />{label(status)}</span>;
}

function ConfirmAction({ body, detail, busy, onClose, onConfirm }: { body: ActionBody; detail: DisputeDetail; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const action = ACTIONS.find((item) => item.key === body.action)!;
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="section-heading"><span className="section-icon"><action.icon /></span><button className="icon-button" title="Close confirmation" aria-label="Close confirmation" disabled={busy} onClick={onClose}><X /></button></div>
    <h2 id="confirm-title">{action.title === "Accept claim" ? `Refund ${money(detail.dispute_amount)}?` : `${action.title}?`}</h2>
    <p className="muted">{detail.dispute_id}</p>
    <p>{body.action === "ACCEPT_CLAIM" ? "Accepting this claim authorizes a refund through PayPal. This action cannot be undone here." : "Confirm the details below before sending them to PayPal."}</p>
    <div className="review-copy">{body.action === "SEND_MESSAGE" ? body.message : body.action === "ACCEPT_CLAIM" ? body.note : body.notes}</div>
    {body.action === "PROVIDE_EVIDENCE" && body.trackingNumber && <p className="muted">{body.carrier} / {body.trackingNumber}</p>}
    <div className="button-row"><button disabled={busy} onClick={onClose}>Back to editing</button><button className="primary" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" /> : <Check />}{busy ? "Sending..." : action.cta}</button></div>
  </dialog>;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [disputes, setDisputes] = useState<DisputeSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [result, setResult] = useState<TriageResult | null>(null);
  const [busy, setBusy] = useState<string | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("open");
  const [view, setView] = useState<"cases" | "activity">("cases");
  const [action, setAction] = useState<Triage["recommendedAction"]>("SEND_MESSAGE");
  const [confirmation, setConfirmation] = useState<ActionBody | null>(null);
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [acceptNote, setAcceptNote] = useState("");
  const selectionVersion = useRef(0);

  useEffect(() => {
    let active = true;
    Promise.all([api.health(), api.disputes(), api.audit()]).then(([connection, list, log]) => {
      if (active) { setHealth(connection); setDisputes(list); setAudit(log); }
    }).catch((failure: Error) => { if (active) setError(failure.message); })
      .finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, []);

  const select = async (id: string) => {
    const version = ++selectionVersion.current;
    setSelected(id); setResult(null); setDetail(null); setError(null); setNotice(null);
    try {
      const next = await api.dispute(id);
      if (version === selectionVersion.current) setDetail(next);
    } catch (failure) { if (version === selectionVersion.current) setError((failure as Error).message); }
  };

  const refresh = async () => {
    setBusy("refresh"); setError(null);
    try {
      const [connection, list, log] = await Promise.all([api.health(), api.disputes(), api.audit()]);
      setHealth(connection); setDisputes(list); setAudit(log);
      if (selected) await select(selected);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  };

  const runTriage = async () => {
    if (!selected) return;
    setBusy("triage"); setError(null); setNotice(null); setResult(null);
    try {
      const analysis = await api.triage(selected);
      setResult(analysis); setAction(analysis.triage.recommendedAction);
      setMessage(analysis.triage.draftMessageToBuyer); setNotes(analysis.triage.evidenceNotes);
      setCarrier(analysis.triage.trackingCarrier ?? ""); setTracking(analysis.triage.trackingNumber ?? "");
      setAcceptNote(analysis.triage.reasoning);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  };

  const execute = async () => {
    if (!selected || !confirmation) return;
    setBusy(confirmation.action); setError(null);
    try {
      const response = await api.act(selected, confirmation);
      setDetail(response.dispute); setResult(null); setConfirmation(null);
      setDisputes((current) => current.map((item) => item.dispute_id === selected ? { ...item, ...response.dispute } : item));
      setNotice(`${ACTIONS.find((item) => item.key === confirmation.action)?.title}: submitted to PayPal.`);
      try { setAudit(await api.audit()); } catch { setNotice("Action submitted to PayPal. Activity could not be refreshed."); }
    } catch (failure) { setConfirmation(null); setError((failure as Error).message); }
    finally { setBusy(null); }
  };

  const triage = result?.triage;
  const resolved = detail?.status === "RESOLVED";
  const open = disputes.filter((item) => item.status !== "RESOLVED");
  const dueSoon = open.filter((item) => { const days = daysLeft(item.seller_response_due_date); return days !== null && days <= 3; }).length;
  const visible = disputes.filter((item) => (filter === "all" || (filter === "open" ? item.status !== "RESOLVED" : item.status === "RESOLVED")) && `${item.dispute_id} ${item.buyer_name ?? ""} ${reason(item.reason)} ${item.item ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const bodies: Record<Triage["recommendedAction"], ActionBody> = {
    SEND_MESSAGE: { action: "SEND_MESSAGE", message },
    PROVIDE_EVIDENCE: { action: "PROVIDE_EVIDENCE", notes, carrier, trackingNumber: tracking },
    ACCEPT_CLAIM: { action: "ACCEPT_CLAIM", note: acceptNote, reason: triage?.acceptReason ?? "REASON_NOT_SET" },
  };
  const refundBlocked = !health || !detail || !Number.isFinite(Number(detail.dispute_amount?.value)) || Number(detail.dispute_amount?.value) > health.maxAcceptAmount;
  const draftEmpty = !(action === "SEND_MESSAGE" ? message : action === "PROVIDE_EVIDENCE" ? notes : acceptNote).trim();
  const trackingIncomplete = action === "PROVIDE_EVIDENCE" && Boolean(carrier.trim()) !== Boolean(tracking.trim());

  return <div className="app">
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <header className="topbar">
      <a className="brand" href="/" aria-label="DisputeDesk home"><span className="brand-mark"><ShieldCheck /></span>DisputeDesk</a>
      <span className="workspace-label">Merchant workspace</span>
      <div className="connections">
        <span className={`connection ${health?.mockPayPal ? "attention" : ""}`}><span className="status-dot" />{health ? health.mockPayPal ? "Sample data" : "PayPal sandbox" : "Connecting"}</span>
        <span className={`connection ${health && !health.aiConfigured ? "attention" : ""}`}><Sparkles />{health?.aiConfigured ? health.model : "AI not configured"}</span>
      </div>
    </header>

    <div className="page-heading"><div><div className="eyebrow">RESOLUTION WORKSPACE</div><h1>Disputes</h1></div><button onClick={refresh} disabled={busy !== null}><RefreshCw className={busy === "refresh" ? "spin" : ""} />Refresh</button></div>
    <div className="overview" aria-label="Dispute overview">
      <div><span className="metric-icon blue"><Inbox /></span><div><span className="muted">Open cases</span><strong>{busy === "loading" ? "-" : open.length}</strong></div></div>
      <div><span className="metric-icon amber"><Clock3 /></span><div><span className="muted">Due within 3 days</span><strong>{busy === "loading" ? "-" : dueSoon}</strong></div></div>
      <div><span className="metric-icon green"><CheckCircle2 /></span><div><span className="muted">Resolved cases</span><strong>{busy === "loading" ? "-" : disputes.length - open.length}</strong></div></div>
    </div>
    <nav className="view-tabs" aria-label="Workspace views"><button aria-current={view === "cases" ? "page" : undefined} onClick={() => setView("cases")}><Inbox />Case inbox</button><button aria-current={view === "activity" ? "page" : undefined} onClick={() => setView("activity")}><History />Activity<span className="count">{audit.length}</span></button></nav>
    {error && <div className="banner error" role="alert"><TriangleAlert /><span>{error}</span><button className="icon-button" onClick={() => setError(null)} title="Dismiss error" aria-label="Dismiss error"><X /></button></div>}
    {notice && <div className="banner success" role="status"><CheckCircle2 /><span>{notice}</span><button className="icon-button" onClick={() => setNotice(null)} title="Dismiss notification" aria-label="Dismiss notification"><X /></button></div>}

    <main id="workspace" className={view === "cases" ? "workspace" : "activity-view"}>
      {view === "activity" ? <section><div className="section-heading"><h2>Recent activity</h2><span className="muted">Current server session</span></div>{audit.length ? <ol className="activity-list">{audit.map((entry, index) => <li key={`${entry.time}-${index}`}><span className="metric-icon green"><Check /></span><div><h3>{label(entry.action)}</h3><p className="muted">{entry.disputeId} / {date(entry.time)} / {new Date(entry.time).toLocaleTimeString()}</p><p>{entry.detail}</p></div></li>)}</ol> : <div className="empty"><History /><h2>No activity yet</h2><p>Submitted actions will appear here.</p></div>}</section> : <>
        <aside className="queue" aria-label="Case inbox">
          <div className="section-heading"><h2>Cases</h2><span className="count">{visible.length}</span></div>
          <div className="search-field"><Search /><input aria-label="Search cases" placeholder="Search cases or buyers" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button className="icon-button" title="Clear search" aria-label="Clear search" onClick={() => setQuery("")}><X /></button>}</div>
          <div className="segmented" aria-label="Case status filter">{["open", "resolved", "all"].map((value) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label(value)}</button>)}</div>
          {busy === "loading" ? <div className="empty" role="status"><LoaderCircle className="spin" /><p>Loading cases...</p></div> : <ul className="case-list">{visible.map((item) => <li key={item.dispute_id}><button className={`case-item ${selected === item.dispute_id ? "selected" : ""}`} aria-pressed={selected === item.dispute_id} disabled={busy !== null} onClick={() => select(item.dispute_id)}><span className="section-heading"><strong>{money(item.dispute_amount)}</strong><ChevronRight /></span><span className="case-reason">{reason(item.reason)}</span><span className="case-id">{item.dispute_id}</span><Status status={item.status} />{item.status !== "RESOLVED" && <span className="case-deadline"><Clock3 />{deadline(daysLeft(item.seller_response_due_date))}</span>}</button></li>)}</ul>}
          {busy !== "loading" && !visible.length && <div className="empty compact"><Search /><h3>No matching cases</h3><p>{query || filter !== "all" ? "Try a different search or status." : "No disputes returned by PayPal."}</p></div>}
        </aside>

        <section className="case-workspace" aria-label="Selected case" aria-busy={busy === "triage"}>
          {!selected ? <div className="empty welcome"><Inbox /><h2>Your case workspace</h2><p>Select a case from the inbox.</p></div> : !detail ? <div className="empty" role="status">{error ? <><TriangleAlert /><p>Case could not be loaded.</p><button disabled={busy !== null} onClick={() => select(selected)}>Try again</button></> : <><LoaderCircle className="spin" /><p>Loading case...</p></>}</div> : <>
            <section className="case-overview">
              <div className="section-heading"><span className="case-id">{detail.dispute_id}</span><Status status={detail.status} /></div>
              <h2 className="case-title">{reason(detail.reason)}</h2>
              <div className="case-facts"><div><span>Disputed amount</span><strong className="amount">{money(detail.dispute_amount)}</strong></div><div><span>Buyer</span><strong>{detail.disputed_transactions?.[0]?.buyer?.name || "Not provided"}</strong></div><div><span>Response deadline</span><strong>{resolved ? "Case resolved" : deadline(daysLeft(detail.seller_response_due_date))}</strong></div></div>
              <div className="case-meta"><span>{detail.disputed_transactions?.[0]?.items?.[0]?.item_name || "Item not provided"}</span>{detail.dispute_life_cycle_stage && <span>{label(detail.dispute_life_cycle_stage)}</span>}<span>Opened {date(detail.create_time)}</span></div>
            </section>

            <section className="case-section"><div className="section-heading"><h2><MessageSquare />Conversation</h2><span className="muted">{detail.messages?.length ?? 0} messages</span></div><div className="thread">{detail.messages?.length ? detail.messages.map((entry, index) => <article key={index} className={`message ${entry.posted_by === "SELLER" ? "seller" : ""}`}><div className="message-heading"><strong>{label(entry.posted_by)}</strong><time dateTime={entry.time_posted}>{date(entry.time_posted)}</time></div><p>{entry.content}</p></article>) : <p className="muted">No messages available.</p>}</div></section>

            <section className="case-section analysis-section"><div className="section-heading"><h2><Sparkles />AI assessment</h2>{!resolved && <button className={triage ? "" : "primary"} disabled={busy !== null || !health?.aiConfigured} onClick={runTriage}>{busy === "triage" ? <LoaderCircle className="spin" /> : <Sparkles />}{busy === "triage" ? "Analyzing..." : triage ? "Re-run analysis" : "Run AI triage"}</button>}</div>
              {!health?.aiConfigured && !resolved && <p className="inline-warning">AI is unavailable. Configure the selected provider's API key on the server, then restart.</p>}
              {!triage && <p className="muted" role="status">{busy === "triage" ? "Reviewing the dispute and available transaction records..." : resolved ? "This case is resolved." : "No assessment yet."}</p>}
              {triage && result && <div className="analysis-result"><div className="section-heading"><span className={`status ${triage.priority === "low" ? "positive" : "attention"}`}>{label(triage.priority)} priority</span><span className="muted small">{health?.model}</span></div><p>{triage.summary}</p><div className="assessment"><div><span className="eyebrow">SUGGESTED NEXT STEP</span><h3>{ACTIONS.find((item) => item.key === triage.recommendedAction)?.title}</h3><p>{triage.reasoning}</p></div><div className="estimate"><strong>{Math.round(triage.winProbability)}<span>%</span></strong><span>AI win estimate</span><span className="small muted">Unverified, not a guarantee</span><progress max={100} value={triage.winProbability} aria-label="Unverified AI win estimate" /></div></div>
                {triage.fraudSignals.length > 0 && <div className="risk-notes"><h3><TriangleAlert />Risk signals to review</h3><ul>{triage.fraudSignals.map((signal, index) => <li key={index}>{signal}</li>)}</ul></div>}
                {triage.evidenceChecklist.length > 0 && <div className="evidence-checklist"><h3>Evidence to review</h3><ul>{triage.evidenceChecklist.map((item, index) => <li key={index}><FileCheck2 /><span>{item}</span></li>)}</ul></div>}
                <details className="investigation"><summary>Investigation / {result.trace.length} tool calls</summary><ol>{result.trace.map((tool, index) => <li key={index}>{label(tool.tool)}</li>)}</ol></details>
              </div>}
            </section>

            {triage && !resolved && <section className="case-section action-section"><div className="section-heading"><h2><ShieldCheck />Review & respond</h2><span className="muted small">Human approval required</span></div><div className="action-selector" aria-label="Response action">{ACTIONS.map((item) => <button key={item.key} aria-pressed={action === item.key} onClick={() => setAction(item.key)} disabled={busy !== null}><item.icon /><span>{item.title}{triage.recommendedAction === item.key && <small>AI suggested</small>}</span></button>)}</div>
              <form onSubmit={(event) => { event.preventDefault(); setConfirmation(bodies[action]); }}>
                {action === "SEND_MESSAGE" && <label className="field">Message to buyer<textarea required maxLength={2000} rows={6} value={message} onChange={(event) => setMessage(event.target.value)} /></label>}
                {action === "PROVIDE_EVIDENCE" && <><label className="field">Evidence notes<textarea required maxLength={2000} rows={6} value={notes} onChange={(event) => setNotes(event.target.value)} /></label><div className="input-pair"><label className="field">Carrier (optional)<input maxLength={100} value={carrier} onChange={(event) => setCarrier(event.target.value)} /></label><label className="field">Tracking number (optional)<input maxLength={100} value={tracking} onChange={(event) => setTracking(event.target.value)} /></label></div>{trackingIncomplete && <p className="inline-warning">Provide both a carrier and tracking number, or leave both empty.</p>}</>}
                {action === "ACCEPT_CLAIM" && <><div className="refund-summary"><span>Claim amount</span><strong>{money(detail.dispute_amount)}</strong></div><label className="field">Acceptance note<textarea required maxLength={2000} rows={4} value={acceptNote} onChange={(event) => setAcceptNote(event.target.value)} /></label>{refundBlocked && <p className="inline-warning">This claim exceeds the configured limit or its amount is unavailable. Review it in PayPal's Resolution Center.</p>}</>}
                <p className="draft-warning"><TriangleAlert />AI-generated draft. Verify all facts and completed actions before submitting.</p>
                <div className="action-footer"><span className="muted small">{detail.dispute_id}</span><button type="submit" className="primary" disabled={busy !== null || draftEmpty || trackingIncomplete || (action === "ACCEPT_CLAIM" && refundBlocked)}>Review {action === "SEND_MESSAGE" ? "message" : action === "PROVIDE_EVIDENCE" ? "evidence" : "refund"}<ArrowRight /></button></div>
              </form>
            </section>}
            {resolved && <div className="banner success"><CheckCircle2 /><span>{detail.dispute_outcome ? label(detail.dispute_outcome) : "This dispute is resolved."}</span></div>}
            <a className="back-to-top" href="#workspace"><ArrowLeft />Back to case inbox</a>
          </>}
        </section>
      </>}
    </main>
    <footer className="page-footer"><span>DisputeDesk</span><span>Independent tool / PayPal sandbox</span><span><ShieldCheck />Merchant-approved actions</span></footer>
    {confirmation && detail && <ConfirmAction body={confirmation} detail={detail} busy={busy !== null} onClose={() => setConfirmation(null)} onConfirm={execute} />}
  </div>;
}