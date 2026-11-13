import type { RefundRequested } from '../bus/events';
import type { Message, Subscriber } from '../bus/inMemoryBus';
import type { PaymentGateway } from '../integrations/paymentGateway';

/** One line in the refund ledger. */
export interface LedgerEntry {
  entryId: string;
  bookingId: string;
  organizer: string;
  amountCents: number;
  reason: string;
  recordedAtMinute: number;
  /** The refund message this entry was written for: the idempotency key. */
  messageId: string;
}

/**
 * Books refunds and sends the money back.
 *
 * For a refund message the handler writes a ledger entry, then calls the
 * payment provider for the same amount. The ledger is append only: entries are
 * numbered in the order they were written, and nothing edits or removes one
 * after the fact.
 *
 * The bus delivers at least once, so the same message id can arrive any number
 * of times. The handler uses the message id as an idempotency key and guards
 * each of its two effects separately:
 *
 * - the ledger entry is written only if no entry carries this message id yet;
 * - the payment is sent only if no settlement has been recorded for this
 *   message id yet. The id is recorded only after the provider accepted the
 *   refund, so a delivery that failed at the provider is retried on the next
 *   delivery instead of being skipped.
 */
export class RefundLedger implements Subscriber<RefundRequested> {
  readonly name = 'RefundLedger';

  private readonly entries: LedgerEntry[] = [];
  private readonly settledMessageIds = new Set<string>();
  private readonly gateway: PaymentGateway;

  constructor(gateway: PaymentGateway) {
    this.gateway = gateway;
  }

  handle(message: Message<RefundRequested>): void {
    const event = message.payload;
    if (!this.entries.some((entry) => entry.messageId === message.id)) {
      this.entries.push({
        entryId: `led-${this.entries.length + 1}`,
        bookingId: event.bookingId,
        organizer: event.organizer,
        amountCents: event.amountCents,
        reason: event.reason,
        recordedAtMinute: message.publishedAtMinute,
        messageId: message.id,
      });
    }
    if (!this.settledMessageIds.has(message.id)) {
      this.gateway.refund(event.bookingId, event.amountCents);
      this.settledMessageIds.add(message.id);
    }
  }

  /** Every ledger entry, oldest first. */
  all(): LedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Entries for one booking, oldest first. */
  forBooking(bookingId: string): LedgerEntry[] {
    return this.all().filter((entry) => entry.bookingId === bookingId);
  }

  /** What the ledger says has been refunded, in cents. */
  totalRefundedCents(): number {
    return this.entries.reduce((sum, entry) => sum + entry.amountCents, 0);
  }

  size(): number {
    return this.entries.length;
  }
}
