import { j } from './sql.js';

/**
 * الفاتورة الإلكترونية السعودية (ZATCA / هيئة الزكاة والضريبة والجمارك).
 *
 * ما يُنفَّذ هنا:
 *   • رمز QR بترميز TLV ثم Base64 بالحقول الإلزامية الخمسة (المرحلة الأولى)
 *   • معرّف UUID لكل فاتورة
 *   • مستند UBL 2.1 بصيغة XML
 *   • سلسلة التجزئة (PIH) — تجزئة كل فاتورة تحمل تجزئة سابقتها
 *
 * ما لا يُنفَّذ هنا — ويتطلّب تسجيل المنشأة لدى الهيئة:
 *   • الختم التشفيري (CSID) وشهادة التوقيع، والربط المباشر ببوابة «فاتورة»
 * الوحدة مُهيّأة لهما: `signInvoice()` نقطة الإدخال، وحقول الوسم ٦ و٧ و٨
 * تُضاف إلى رمز QR تلقائياً متى توفّرت الشهادة.
 *
 * ملاحظة تنظيمية: هذه فواتير اشتراك بين منشأتين (B2B)، وتصنيفها «فاتورة ضريبية»
 * لا «مبسّطة» — أي أن رمز QR ليس إلزامياً عليها في المرحلة الأولى، لكن توليده
 * لا يضرّ ويُسهّل التحقق، وبيانات المشتري (الاسم والرقم الضريبي والعنوان)
 * إلزامية وهي مثبَّتة في الفاتورة وقت الإصدار.
 */

const enc = new TextEncoder();

/** ترميز TLV: [رقم الوسم][الطول][القيمة] */
export function tlv(tag, value) {
  const bytes = enc.encode(String(value ?? ''));
  if (bytes.length > 255) throw new Error(`قيمة الوسم ${tag} أطول من ٢٥٥ بايت`);
  const out = new Uint8Array(2 + bytes.length);
  out[0] = tag; out[1] = bytes.length; out.set(bytes, 2);
  return out;
}

export function concatBytes(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export const toBase64 = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export const fromBase64 = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

/** يفك رمز QR إلى حقوله — يُستخدم في التدقيق */
export function decodeQR(b64) {
  const bytes = fromBase64(b64);
  const out = {};
  const dec = new TextDecoder();
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i];
    const len = bytes[i + 1];
    out[tag] = dec.decode(bytes.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return out;
}

const money = (v) => Number(v || 0).toFixed(2);

/**
 * رمز QR للفاتورة.
 * الوسوم ١–٥ إلزامية، و٦–٨ تُضاف متى توفّر الختم التشفيري.
 */
export function buildQR({ sellerName, vatNumber, timestamp, total, vatAmount, xmlHash = null, signature = null, publicKey = null }) {
  const chunks = [
    tlv(1, sellerName),
    tlv(2, vatNumber),
    tlv(3, timestamp),
    tlv(4, money(total)),
    tlv(5, money(vatAmount))
  ];
  if (xmlHash) chunks.push(tlv(6, xmlHash));
  if (signature) chunks.push(tlv(7, signature));
  if (publicKey) chunks.push(tlv(8, publicKey));
  return toBase64(concatBytes(chunks));
}

/** تجزئة SHA-256 بترميز Base64 (صيغة الهيئة لسلسلة التجزئة) */
export async function sha256Base64(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(text));
  return toBase64(new Uint8Array(digest));
}

/** تجزئة الفاتورة الأولى في السلسلة كما تحدّدها الهيئة */
export const GENESIS_HASH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * مستند UBL 2.1 للفاتورة الضريبية.
 * البنية مطابقة لما تتوقّعه الهيئة، وموضع التوقيع (UBLExtensions) يُملأ عند
 * توفّر الشهادة.
 */
export function buildUBL(invoice, { seller, buyer, previousHash }) {
  const issued = new Date(invoice.issued_at);
  const date = issued.toISOString().slice(0, 10);
  const time = issued.toISOString().slice(11, 19) + 'Z';
  const cur = invoice.currency || 'SAR';
  const addr = seller.address || {};
  const bAddr = buyer.address || {};

  const line = `
    <cac:InvoiceLine>
      <cbc:ID>1</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">1</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${cur}">${money(invoice.subtotal)}</cbc:LineExtensionAmount>
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${cur}">${money(invoice.vat_amount)}</cbc:TaxAmount>
        <cbc:RoundingAmount currencyID="${cur}">${money(invoice.total)}</cbc:RoundingAmount>
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${esc(`اشتراك ${invoice.plan_name} — ${invoice.cycle === 'yearly' ? 'سنوي' : 'شهري'}`)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>S</cbc:ID>
          <cbc:Percent>${money(invoice.vat_rate)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${cur}">${money(invoice.subtotal)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(invoice.number)}</cbc:ID>
  <cbc:UUID>${esc(invoice.zatca_uuid)}</cbc:UUID>
  <cbc:IssueDate>${date}</cbc:IssueDate>
  <cbc:IssueTime>${time}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0100000">${invoice.doc_type === 'credit_note' ? '381' : '388'}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${esc(previousHash)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  ${buyer.po_number ? `<cac:OrderReference><cbc:ID>${esc(buyer.po_number)}</cbc:ID></cac:OrderReference>` : ''}
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="CRN">${esc(seller.cr_number)}</cbc:ID></cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(addr.street)}</cbc:StreetName>
        <cbc:CitySubdivisionName>${esc(addr.district)}</cbc:CitySubdivisionName>
        <cbc:CityName>${esc(addr.city)}</cbc:CityName>
        <cbc:PostalZone>${esc(addr.postal_code)}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(seller.vat_number)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(seller.name)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(bAddr.street)}</cbc:StreetName>
        <cbc:CityName>${esc(bAddr.city)}</cbc:CityName>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(buyer.vat_number)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(buyer.name)}</cbc:RegistrationName></cac:PartyLegalEntity>
      ${buyer.cr_number ? `<cac:PartyIdentification><cbc:ID schemeID="CRN">${esc(buyer.cr_number)}</cbc:ID></cac:PartyIdentification>` : ''}
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${money(invoice.vat_amount)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${money(invoice.subtotal)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${money(invoice.vat_amount)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${money(invoice.vat_rate)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${money(invoice.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${money(invoice.subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${money(invoice.total)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${cur}">${money(invoice.discount)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="${cur}">${money(invoice.total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${line}
</Invoice>`;
}

/**
 * موضع الختم التشفيري — يُفعّل عند توفّر شهادة CSID من الهيئة.
 * حتى ذلك الحين تُختم الفاتورة بالحقول الإلزامية وسلسلة التجزئة فقط.
 */
export async function signInvoice(/* xml, credentials */) {
  return { signature: null, publicKey: null, certificate: null, signed: false };
}

/**
 * يضع وسم ZATCA على فاتورة صادرة: UUID، سلسلة التجزئة، رمز QR، ومستند XML.
 * تُستدعى من `issueInvoice`، ولا تفعل شيئاً إن كانت الميزة معطّلة.
 */
export async function stampZatca(app, invoice, settings) {
  if (!settings?.zatca_enabled || !invoice) return invoice;

  const prev = await app.db.get(
    `SELECT zatca_hash FROM subscription_invoices
     WHERE zatca_hash IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1`, invoice.id);
  const previousHash = prev?.zatca_hash || GENESIS_HASH;

  const uuid = globalThis.crypto.randomUUID();
  const buyer = j(invoice.buyer, {}) || {};
  const seller = {
    name: settings.platform_name,
    vat_number: settings.vat_number || '',
    cr_number: settings.cr_number || '',
    address: j(settings.seller_address, {}) || {}
  };

  const xml = buildUBL({ ...invoice, zatca_uuid: uuid }, { seller, buyer, previousHash });
  const hash = await sha256Base64(xml);
  const stamp = await signInvoice(xml);

  const qr = buildQR({
    sellerName: seller.name,
    vatNumber: seller.vat_number,
    timestamp: invoice.issued_at,
    total: invoice.total,
    vatAmount: invoice.vat_amount,
    xmlHash: hash,
    signature: stamp.signature,
    publicKey: stamp.publicKey
  });

  /* المستند نفسه يُحفظ في تخزين الجهة المعزول */
  let xmlKey = null;
  if (app.storage) {
    try {
      xmlKey = `tenants/${invoice.tenant_id}/einvoices/${invoice.number}.xml`;
      await app.storage.put(xmlKey, new TextEncoder().encode(xml), { contentType: 'application/xml' });
    } catch { xmlKey = null; }
  }

  await app.db.run(
    `UPDATE subscription_invoices SET zatca_uuid=?, zatca_qr=?, zatca_hash=?, zatca_prev_hash=?, zatca_xml_key=?
     WHERE id=?`,
    uuid, qr, hash, previousHash, xmlKey, invoice.id);

  return app.db.get('SELECT * FROM subscription_invoices WHERE id=?', invoice.id);
}

/** يتحقّق من سلامة سلسلة التجزئة — تدقيق داخلي */
export async function verifyChain(app, { limit = 500 } = {}) {
  const rows = await app.db.all(
    `SELECT id, number, zatca_hash, zatca_prev_hash FROM subscription_invoices
     WHERE zatca_hash IS NOT NULL ORDER BY id LIMIT ?`, limit);
  const breaks = [];
  let expected = GENESIS_HASH;
  for (const r of rows) {
    if (r.zatca_prev_hash !== expected) breaks.push({ id: r.id, number: r.number, expected, found: r.zatca_prev_hash });
    expected = r.zatca_hash;
  }
  return { checked: rows.length, intact: breaks.length === 0, breaks };
}
