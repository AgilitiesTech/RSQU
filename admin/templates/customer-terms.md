<!--
  CUSTOMER TERMS & CONDITIONS — master template for HitchPoint businesses.

  Each business is the seller and merchant of record for its own customers. HitchPoint fills this
  template with the business's one-time setup details; the business OWNER reviews it, may edit it,
  and gives final approval (recorded with name, title, attestation, time and IP). Customers accept
  the approved version when they sign a proposal or pay online.

  After editing this file, bump TEMPLATE_VERSION in src/customer-terms.js so every business is asked
  to review and re-approve.

  This template is a starting point, not legal advice. Laws on warranties, refunds, home-solicitation
  cancellations, late fees, liens, licensing and e-signatures vary by state and trade.

  Syntax: {{field}} · {{#if field}} … {{/if}} · {{#if field}} … {{else}} … {{/if}}
          # / ## headings, "- " bullets, **bold**, blank line = new paragraph, --- = divider.
  HTML comments like this one are removed before display.
-->
# Terms and Conditions of Service

**{{business_name}}**{{#if dba_differs}} (doing business as {{business_dba}}){{/if}}
{{business_address}}
{{business_phone}} · {{business_email}}{{#if business_website}} · {{business_website}}{{/if}}

These Terms and Conditions ("Terms") apply to all services, labor, parts, and materials that {{business_name}} ("we," "us," or "our") provides to you, the customer ("you"). By signing a proposal, work order, or agreement that references these Terms, by approving work electronically, or by submitting payment, you agree to these Terms. If a proposal or agreement you sign conflicts with these Terms, the signed proposal or agreement controls for that job.

**Who you are dealing with.** {{business_name}} is the seller of all services, parts, and materials under these Terms and is solely responsible for them. Online payments are processed by Stripe for {{business_name}}, and charges appear on your statement under our business name. We use software provided by {{platform_name}} for our website, proposals, and payment pages. {{platform_name}} and Stripe are not parties to these Terms and do not provide our services.

## Key points (summary only — the full Terms below control)

- We guarantee our workmanship for **{{warranty_days}} days** from the date the work is completed (Section 7).
- The guarantee covers only the specific work we performed. Other parts or systems found to need repair later are separate jobs.
- **All sales are final.** We do not refund labor performed or materials used, except as these Terms or the law require (Section 9).
- Parts are covered only by their manufacturer's warranty. You handle the claim; we help with the paperwork (Section 8).
{{#if deposit_amount}}- A **{{deposit_amount}}** {{deposit_label_lower}} deposit is due when you book a visit and is credited toward the job (Section 3).
{{/if}}- Payment is due {{balance_due_label}} (Section 4). Sales tax is added where required by law.

## 1. Scope of Work and Estimates

- The work we will perform is limited to what is described in your proposal, estimate, or work order ("Scope of Work"). Anything not described is not included.
- Estimates are based on the information and conditions visible at the time of inspection. Unless the proposal says otherwise, estimates are valid for {{estimate_valid_days}} days.
- Concealed or unforeseen conditions (for example, hidden damage, code violations, or deteriorated components discovered once work begins) may change the work required and the price. We will explain the issue and get your approval under Section 2 before doing any additional work.

## 2. Changes and Additional Work

- We will not perform work outside the Scope of Work, or charge more than the approved price, without your approval. Approval may be in writing, by email or text, or through our online proposal, and the approved change becomes part of your agreement.
- Additional repairs, parts, or components identified during or after the service are separate jobs. They are not included in the original price or in the guarantee for the original work unless you approve them as a change.

## 3. Pricing, Deposits, Taxes, and Fees

- Prices are in U.S. dollars. Applicable sales and use taxes are added where required by law and shown on your proposal, invoice, or receipt.
{{#if deposit_amount}}- **{{deposit_label}}:** a deposit of **{{deposit_amount}}** is due when you book a visit. It is credited toward the job if you approve the work.
{{/if}}{{#if hourly_rate}}- Work quoted on a time-and-materials basis is billed at **{{hourly_rate}} per hour** plus materials, unless your proposal states a different rate.
{{/if}}- Special-order items, permits, disposal fees, and equipment rental are billed as stated in your proposal.

## 4. Payment Terms

- Payment in full is due {{balance_due_label}}, less any deposit already paid.
- You may pay online by card or bank account, or by any other method we accept. Online payments are processed by Stripe for {{business_name}}; we do not store your full card or bank account number.
{{#if late_fee_percent}}- Balances not paid when due accrue a late charge of **{{late_fee_percent}}% per month** on the overdue amount, or the maximum amount allowed by law, whichever is less.
{{/if}}{{#if returned_payment_fee}}- A fee of **{{returned_payment_fee}}**, or the maximum allowed by law if less, applies to any payment that is returned or declined.
{{/if}}- You agree to pay reasonable costs of collecting overdue amounts, including attorney's fees, where permitted by law.
- If you have a question about a charge, please contact us first so we can resolve it quickly. This does not limit any rights you have with your bank or card issuer.
- To the extent permitted by the law of {{governing_state}}, we may have lien rights against the property where we performed work if amounts remain unpaid. Where state law requires a separate lien or preliminary notice, we will provide it.

## 5. Scheduling, Access, and Cancellations

- Arrival times are estimated windows. Weather, road conditions, part availability, emergencies, and earlier jobs can cause delays, and we will keep you informed.
- You agree to provide safe and reasonable access to the vehicle, trailer, or work area, access to power and water where needed, and to secure pets and remove personal items from the work area. We are not responsible for items left in the work area.
- Please cancel or reschedule at least **{{cancellation_notice_hours}} hours** before your appointment.{{#if cancellation_fee}} If you cancel with less notice, or we cannot access the work area at the scheduled time, a fee of **{{cancellation_fee}}** may apply.{{/if}}

## 6. Your Right to Cancel (Certain Sales Made at Your Home)

If you are buying for personal, family, or household purposes and this agreement was made at your home or at a location other than our permanent place of business, you may have the right to cancel within three business days without penalty under the Federal Trade Commission's Cooling-Off Rule and/or {{governing_state}} law. When that right applies, we will tell you about it at the time of sale and give you a separate Notice of Cancellation form explaining how to cancel. Nothing in these Terms, including Section 9, limits that right.

## 7. Workmanship Guarantee

We guarantee the workmanship (labor) we perform for **{{warranty_days}} days** from the date the work is completed. If a defect in our workmanship appears during that period, notify us (email or text is fine) before the guarantee period ends. We will inspect the work and, if the defect is covered, repair or re-perform the affected work at no additional charge. If we are unable to correct a covered defect, we will refund the labor charge for the defective portion of the work.

This guarantee applies strictly to the specific work performed under your Scope of Work. It does not cover:

- additional parts, components, or related systems identified as requiring repair after the initial service is complete, even if they were discovered during our service;
- pre-existing conditions, or problems caused by normal wear and tear, misuse, neglect, accidents, road damage, power surges, freezing, weather, pests, or acts of nature;
- work that has been altered, repaired, or tampered with by anyone other than us;
- parts or materials you supplied; or
- the failure of a part or material that is covered by a manufacturer's warranty (see Section 8), unless the failure was caused by our workmanship.

Repair or re-performance does not extend the original guarantee period.

## 8. Manufacturer Warranties

- Parts and materials we install are covered only by their manufacturers' warranties, if any. We do not provide a separate warranty on parts or materials.
- If a part or material fails under its manufacturer's warranty, you are responsible for the warranty claim and return process, including any registration or other requirements the manufacturer sets.
- We will provide reasonable administrative support to help you complete and submit your claim, including copies of invoices, part and serial numbers, installation dates, any photos or documentation we have, and guidance on the manufacturer's process.
- Labor to remove and replace a part that failed under its manufacturer's warranty is a separate job unless the manufacturer covers it or the failure was caused by our workmanship. We will quote that labor before performing it.

## 9. All Sales Final

Because our services commit time, travel, labor, and materials to your job, all sales are final. Except as stated in these Terms (including your right to cancel in Section 6 and the guarantee in Section 7) or as required by law, we do not provide refunds for time spent on labor or for materials used or installed.{{#if deposit_amount}} A deposit for a visit we have made is applied to the job or retained for the visit, and is not refunded.{{/if}} Unused, returnable materials may be credited at our discretion, less any restocking fee charged by our supplier. Approved refunds are issued by {{business_name}} to your original payment method.

## 10. Disclaimer of Other Warranties

**EXCEPT FOR THE WORKMANSHIP GUARANTEE IN SECTION 7 AND ANY WARRANTY THAT CANNOT BE EXCLUDED UNDER APPLICABLE LAW, WE MAKE NO OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR WORKMANLIKE PERFORMANCE.** Some states do not allow the exclusion of implied warranties, so this exclusion may not apply to you.

## 11. Limitation of Liability

To the fullest extent permitted by law:

- we are not liable for indirect, incidental, special, or consequential damages, such as loss of use, lost income, travel or lodging costs, or inconvenience; and
- our total liability for any claim arising from a job is limited to the amount you paid us for that job.

These limits do not apply to personal injury or death caused by our negligence, to damage caused by our gross negligence or willful misconduct, or to any liability that cannot be limited under applicable law.

## 12. Hazardous Materials and Unsafe Conditions

Unless your Scope of Work specifically includes it, we do not test for, handle, or remove hazardous materials such as mold, biohazards, or leaking propane or fuel beyond what the repair requires. If we encounter unsafe conditions, we may stop work until the condition is addressed. Any resulting changes in scope, schedule, or price will be handled under Section 2.

## 13. Licensing, Insurance, and Personnel

{{#if license_number}}- We are licensed{{#if license_authority}} by {{license_authority}}{{/if}} under license number **{{license_number}}**.
{{/if}}{{#if insured}}- We carry general liability insurance{{#if insurance_carrier}} through {{insurance_carrier}}{{/if}}. A certificate of insurance is available on request.
{{/if}}- We are an independent business. We may use qualified employees or subcontractors, and we remain responsible for their work under these Terms.

## 14. Photos and Documentation

We may photograph the vehicle, trailer, or work area before, during, and after service for documentation, quality, and warranty purposes.{{#if marketing_photos}} We may also use photos of completed work in our marketing, but only photos that do not identify you, your family, your license plate, or your address. Tell us at any time if you prefer that we not use photos of your project.{{/if}}

## 15. Privacy

We use your contact, location, vehicle, and job information to provide our services, process payments, and communicate with you about your job, including by call or text to the number you give us. Payments are handled by Stripe. We do not sell your personal information.

## 16. Electronic Records and Signatures

You agree that we may provide proposals, agreements, invoices, receipts, and notices electronically, and that your typed name, finger-drawn signature, online approval, checkbox acceptance, or online payment has the same legal effect as a handwritten signature. When you sign, we record your typed name, signature, the date and time, your IP address, and your device information. You may request a paper copy of any document, or withdraw your consent to electronic records for future documents, at any time by contacting us.

## 17. Disputes and Governing Law

If a problem arises, please contact us first at {{business_phone}} or {{business_email}}. We will work with you in good faith to resolve it, and we ask that you give us 30 days to do so before starting any legal action. If it is not resolved, either of us may bring a claim in small claims court or, to the extent permitted by law, in the state courts located in {{venue_county}} County, {{governing_state}}. These Terms are governed by the laws of the State of {{governing_state}}, without regard to its conflict-of-law rules.

## 18. Events Beyond Our Control

We are not responsible for delays or failure to perform caused by events beyond our reasonable control, such as severe weather, road closures, natural disasters, supply-chain or manufacturer delays, utility outages, labor disputes, or government action. We will notify you and reschedule as soon as reasonably possible.

## 19. General

- **Entire agreement.** These Terms, together with your signed proposal or work order, are the entire agreement between you and us for the job.
- **Changes to these Terms.** We may update these Terms for future jobs. The version you accepted applies to your job.
- **Severability.** If any part of these Terms is found unenforceable, the rest remains in effect, and the unenforceable part will be enforced to the maximum extent allowed.
- **No waiver.** Our failure to enforce any provision is not a waiver of our right to enforce it later.
- **Assignment.** You may not transfer your agreement without our written consent.
- **Survival.** Sections on payment, the workmanship guarantee, manufacturer warranties, limitation of liability, and disputes continue to apply after the work is completed.
- **Notices.** Notices to us must be sent to the address or email below. We will send notices to the contact information you gave us.

---

**Questions?** Contact {{business_name}} at {{business_phone}}, {{business_email}}, or {{business_address}}.{{#if service_area}} Service area: {{service_area}}.{{/if}}
