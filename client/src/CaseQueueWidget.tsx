import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import { useEffect, useState } from "react";

export interface CaseQueueContext {
  openCase?: (disputeId: string) => void;
}

interface CaseCard {
  id: string;
  reason: string;
  amount: number;
  daysLeft: number | null;
}

const REFRESH_MS = 5_000;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const urgency = (days: number | null) => (days === null ? "calm" : days <= 0 ? "critical" : days <= 3 ? "soon" : "calm");
const dueLabel = (days: number | null) => (days === null ? "No deadline" : days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Due today" : `${days}d left`);

export default function CaseQueueWidget(params: AgWidgetParams) {
  const { widgetApi, dataMapping, context } = params;
  const mapping = dataMapping as Record<string, AgWidgetField[] | undefined>;
  const [caseId] = mapping.caseId ?? [];
  const [reason] = mapping.reason ?? [];
  const [amount] = mapping.amount ?? [];
  const [daysLeft] = mapping.daysLeft ?? [];
  const [cards, setCards] = useState<CaseCard[]>([]);

  useEffect(() => {
    if (!caseId || !reason || !amount || !daysLeft) {
      widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const { results } = await widgetApi.getData({ fields: [caseId, reason, amount, daysLeft] });
        if (cancelled) return;
        const next = results.rows
          .map<CaseCard>((row) => ({
            id: String(row[caseId.key]),
            reason: String(row[reason.key]),
            amount: Number(row[amount.key] ?? 0),
            daysLeft: row[daysLeft.key] === null || row[daysLeft.key] === undefined ? null : Number(row[daysLeft.key]),
          }))
          .filter((card) => card.amount > 0)
          .sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || b.amount - a.amount);
        setCards(next);
        widgetApi.setDisplayState(next.length ? "displayed" : "noData");
      } catch {
        // A cancelled request rejects when the widget re-renders; the next refresh retries.
      }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [widgetApi, caseId, reason, amount, daysLeft]);

  const openCase = (context as CaseQueueContext | undefined)?.openCase;

  return (
    <ol className="case-queue">
      {cards.map((card) => (
        <li key={card.id}>
          <button type="button" className={`case-queue-card ${urgency(card.daysLeft)}`} disabled={!openCase} onClick={() => openCase?.(card.id)}>
            <span className="case-queue-main">
              <strong>{money.format(card.amount)}</strong>
              <span>{card.reason}</span>
              <small>{card.id}</small>
            </span>
            <span className="case-queue-due">{dueLabel(card.daysLeft)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
