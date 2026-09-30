// Master switch for offering card payments (Stripe) to customers.
//
// false = hidden: no "Pay by card" button on invoice PDFs or reminder emails,
// no "Copy pay link" action and no Card Payments settings panel. Nothing is
// deleted — the Stripe code, env vars and webhook are untouched, so pay links
// already sent out keep working and card-paid invoices keep their record.
// Set back to true (and redeploy) to bring card payments back.
export const CARD_PAYMENTS_VISIBLE = false;
