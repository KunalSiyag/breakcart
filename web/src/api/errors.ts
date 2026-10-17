import { ApiError, toApiError } from './http';

/**
 * Customer-facing copy for every error code in the contract (plus the browser's own
 * failure modes). Messages read like a real store would show them; the raw code is
 * rendered separately (small, monospace) so learners can connect symptom → cause.
 */

export type Tone = 'error' | 'warn' | 'info';

export interface CustomerMessage {
  title: string;
  detail: string;
  tone: Tone;
}

export type ErrorContext = 'browse' | 'cart' | 'checkout' | 'payment' | 'orders' | 'queue';

function retryHint(err: ApiError): string {
  if (err.retryAfterSec != null && err.retryAfterSec > 0) {
    return `Please try again in ${Math.ceil(err.retryAfterSec)} second${Math.ceil(err.retryAfterSec) === 1 ? '' : 's'}.`;
  }
  return 'Please try again in a moment.';
}

export function customerMessage(input: unknown, context: ErrorContext = 'browse'): CustomerMessage {
  const err = toApiError(input);
  switch (err.code) {
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session expired',
        detail: 'We started a fresh guest session for you. Please try that again.',
        tone: 'warn',
      };
    case 'RATE_LIMITED':
      return {
        title: "Whoa, that's a lot of clicks",
        detail: `You're sending requests faster than we allow. ${retryHint(err)}`,
        tone: 'warn',
      };
    case 'OVERLOADED':
      return {
        title: 'We’re seeing record traffic',
        detail:
          context === 'checkout' || context === 'payment'
            ? 'So many shoppers are checking out right now that we couldn’t take your request. Nothing was charged. Please try again.'
            : 'This part of the store is temporarily paused so checkouts keep working. Please try again shortly.',
        tone: 'warn',
      };
    case 'QUEUE_REQUIRED':
      return {
        title: 'Checkout is busy',
        detail: 'To keep things fair we’re letting shoppers in a few at a time. You’ll join a short virtual queue.',
        tone: 'info',
      };
    case 'BOT_SUSPECTED':
      return {
        title: 'We couldn’t verify this request',
        detail:
          'Our protection against automated buying flagged this action. Take a moment to look at the product page, then try again.',
        tone: 'warn',
      };
    case 'OUT_OF_STOCK':
      return {
        title: 'Sold out',
        detail:
          context === 'checkout'
            ? 'Sorry — one of the items in your cart sold out before we could reserve it. Remove it to continue.'
            : 'Sorry — this item just sold out.',
        tone: 'error',
      };
    case 'PRICE_CHANGED':
      return {
        title: 'The price changed',
        detail: 'A price in your cart was updated since you added it. Please review the new total before placing your order.',
        tone: 'warn',
      };
    case 'COUPON_EXHAUSTED':
      return {
        title: 'Coupon no longer available',
        detail: 'This coupon has reached its usage limit. You can still place the order without it.',
        tone: 'warn',
      };
    case 'PAYMENT_DECLINED':
      return {
        title: 'Payment declined',
        detail: 'Your bank declined this payment and no money was taken. Try again or choose another payment method.',
        tone: 'error',
      };
    case 'PAYMENT_TIMEOUT':
      return {
        title: 'The bank didn’t respond in time',
        detail:
          'We couldn’t confirm your payment. If money was debited it will be reconciled automatically — check your order status before paying again.',
        tone: 'warn',
      };
    case 'PAYMENT_PENDING':
      return {
        title: 'Confirming your payment…',
        detail: 'Your bank is still processing this payment. Please don’t pay again — we’ll update your order shortly.',
        tone: 'info',
      };
    case 'REQUEST_IN_PROGRESS':
      return {
        title: 'Still working on it',
        detail: 'Your previous request is still being processed. Hang tight — we’ll pick up the result.',
        tone: 'info',
      };
    case 'INVALID_STATE':
      return {
        title: 'This order can’t be changed',
        detail:
          context === 'payment'
            ? 'This order is no longer awaiting payment — it may already be paid, failed or expired.'
            : 'The order isn’t in a state that allows this action any more.',
        tone: 'warn',
      };
    case 'NOT_FOUND':
      return {
        title: context === 'orders' ? 'We can’t find that order (yet)' : 'Not found',
        detail:
          context === 'orders'
            ? 'If you just placed it, it can take a few seconds to show up.'
            : 'The page or item you’re looking for doesn’t exist.',
        tone: 'warn',
      };
    case 'UPSTREAM_UNAVAILABLE':
      return {
        title: 'Part of our store is unavailable',
        detail: `One of our systems isn’t responding right now. ${retryHint(err)}`,
        tone: 'error',
      };
    case 'INTERNAL':
    case 'INJECTED_FAULT':
      return {
        title: 'Something went wrong on our side',
        detail: `It’s not you, it’s us. ${retryHint(err)}`,
        tone: 'error',
      };
    case 'SALE_NOT_STARTED':
      return {
        title: 'The sale hasn’t started yet',
        detail: 'Deal prices unlock when the countdown hits zero. Keep this tab open!',
        tone: 'info',
      };
    case 'INVALID_COUPON':
      return {
        title: 'That coupon code isn’t valid',
        detail: 'Check the spelling, or place the order without a coupon.',
        tone: 'warn',
      };
    case 'COUPON_NOT_APPLICABLE':
      return {
        title: 'Coupon not applicable',
        detail: 'Your cart total is below this coupon’s minimum. Add more items or continue without it.',
        tone: 'warn',
      };
    case 'ORDER_EXPIRED':
      return {
        title: 'Your reservation expired',
        detail: 'We held your items for a limited time and released them. Please check out again.',
        tone: 'warn',
      };
    case 'BAD_REQUEST':
      return {
        title: 'We couldn’t process that request',
        detail: err.message || 'Something about the request was invalid.',
        tone: 'error',
      };
    case 'NETWORK_ERROR':
      return {
        title: 'Can’t reach BreakCart',
        detail: 'Check your connection — or the store may be down. Please try again.',
        tone: 'error',
      };
    case 'TIMEOUT':
      return {
        title: 'This is taking too long',
        detail: 'We gave up waiting for a response. Please try again.',
        tone: 'error',
      };
    case 'ABORTED':
      return { title: 'Cancelled', detail: 'The request was cancelled.', tone: 'info' };
    default:
      return {
        title: 'Something went wrong',
        detail: err.message || 'Unexpected error. Please try again.',
        tone: 'error',
      };
  }
}
