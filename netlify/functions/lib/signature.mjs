// Michel's Outlook signature, as the one shared template for every draft the
// Inbox runs create, in any of the three mailboxes (info@, accounts@, energy@
// all sign the same way).
//
// Taken from the signature block of his own sent mail (22 Oct 2026, "Re: 232A
// Princes Highway … Structural Adequacy Certificate"): the same table, the same
// paddings, Calibri at 11pt, the green bar beside the mobile number, the link
// colour and the disclaimer. The logo and the thin divider line are the two
// inline images that mail carried (assets/mworx-logo.png 1000×320,
// assets/mworx-line.png 1117×1, embedded as base64 in signature-images.mjs);
// every draft gets them as inline attachments that the HTML references by
// cid:, which is how Outlook itself carries signature images, so the draft
// shows them without "download pictures" and they travel with the email.
//
// The connector's copy of the sent mail had its <img> tags stripped, so the
// display size of the two images is the one thing taken from a judgement
// rather than from the source: LOGO_WIDTH / LINE_WIDTH below. Compare them
// against the raw HTML of a sent email (inbox-api op "message_read") and
// adjust if Outlook shows the logo larger or smaller than his own signature.

import { LOGO_PNG_BASE64, LINE_PNG_BASE64 } from "./signature-images.mjs";

export const SIGNATURE_NAME = "Michael T.";
export const SIGNATURE_PHONE = "M: 0490 488 423";
export const SIGNATURE_SITE = "www.mworxgroup.com.au";
export const SIGNATURE_SITE_URL = "https://www.mworxgroup.com.au/";
export const SIGNATURE_DISCLAIMER = "This email (including any attachments) is confidential and intended solely for the named addressee. If you have received it in error, please notify the sender by reply email and delete it immediately. Mworx Group makes no warranties that this email is free from viruses or has not been subject to unauthorised interference. Mworx Group accepts no responsibility for any loss or damage arising from the use of this email or its attachments.";

export const LOGO_CID = "mworx-logo@mworxgroup.com.au";
export const LINE_CID = "mworx-line@mworxgroup.com.au";
export const LOGO_WIDTH = 250;   // px; the PNG is 1000×320, so the height follows
export const LOGO_HEIGHT = 80;
export const LINE_WIDTH = 560;   // px; a 1px-high rule, centred above the disclaimer

const GREEN = "rgb(45,184,125)";
const P = "text-align:left;text-indent:0px;margin:0cm;font-family:Calibri,sans-serif;font-size:11pt";

/** The signature block, HTML exactly as Outlook lays his out. */
export function signatureHtml() {
  return `<div id="Signature"><div style="font-family:&quot;Century Gothic&quot;,sans-serif;font-size:12pt;color:rgb(0,0,0)"><br></div>` +
    `<div style="background-color:rgb(255,255,255);margin:0px"><table style="text-align:left;text-indent:0px;max-width:599.15pt"><tbody>` +
    `<tr><td style="text-align:left;text-indent:0px;padding:0cm 0cm 12pt;height:0.7pt"><p style="text-align:left;text-indent:0px;margin:0cm;font-family:Calibri,sans-serif">Regards,</p></td></tr>` +
    `<tr><td style="text-align:left;text-indent:0px;padding:0cm 0cm 15pt;height:0.7pt"><p style="${P}">${SIGNATURE_NAME}</p></td></tr>` +
    `<tr><td style="text-align:left;text-indent:0px;padding:0cm 0cm 12pt;height:0.7pt"><p style="${P}"><img src="cid:${LOGO_CID}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Mworx Group" style="border:0;display:block"></p></td></tr>` +
    `<tr><td style="text-align:left;text-indent:0px;padding:0cm;height:0.7pt"><table style="text-align:left;text-indent:0px;width:200.35pt"><tbody><tr>` +
    `<td style="text-align:left;text-indent:0px;background-color:${GREEN};padding:0cm;width:3.55pt;height:18.4pt"></td>` +
    `<td style="text-align:left;text-indent:0px;padding:0cm 0cm 0cm 9pt;height:18.4pt"><p style="${P}"><b>${SIGNATURE_PHONE}</b><br><a href="${SIGNATURE_SITE_URL}" target="_blank" style="color:${GREEN};margin:0px">${SIGNATURE_SITE}</a></p></td>` +
    `</tr></tbody></table></td></tr>` +
    `<tr><td style="text-align:left;text-indent:0px;padding:15pt 0cm 9pt;height:0.7pt"><p style="text-align:center;text-indent:0px;margin:0cm;font-family:Calibri,sans-serif;font-size:11pt"><img src="cid:${LINE_CID}" width="${LINE_WIDTH}" height="1" alt="" style="border:0"></p></td></tr>` +
    `<tr><td style="text-align:left;text-indent:0px;padding:0cm;height:0.7pt"><p style="${P}"><b>Disclaimer:</b><br>${SIGNATURE_DISCLAIMER}</p></td></tr>` +
    `</tbody></table></div></div>`;
}

/** The two inline images, in the shape Graph takes on POST …/attachments. */
export function signatureAttachments() {
  return [
    { "@odata.type": "#microsoft.graph.fileAttachment", name: "mworx-logo.png", contentType: "image/png", contentBytes: LOGO_PNG_BASE64, isInline: true, contentId: LOGO_CID },
    { "@odata.type": "#microsoft.graph.fileAttachment", name: "mworx-line.png", contentType: "image/png", contentBytes: LINE_PNG_BASE64, isInline: true, contentId: LINE_CID },
  ];
}

/** The same HTML with the images as data: URIs, for a preview outside Outlook. */
export function signatureHtmlForPreview() {
  return signatureHtml()
    .replace(`cid:${LOGO_CID}`, `data:image/png;base64,${LOGO_PNG_BASE64}`)
    .replace(`cid:${LINE_CID}`, `data:image/png;base64,${LINE_PNG_BASE64}`);
}
