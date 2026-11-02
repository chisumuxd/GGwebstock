// 🤖 บอทอ่านสลิปโอนเงิน — ทำงานในเบราว์เซอร์ทั้งหมด ไม่ส่งรูปไปเว็บอื่น (ใช้ทั้ง shop.html และ admin.html)
// 1) QR บนสลิป (มาตรฐานสลิปธนาคารไทย) → เลขอ้างอิงรายการ (แม่นที่สุด)
// 2) อ่านตัวอักษร (OCR) → ยอดเงิน + เลขอ้างอิงสำรองถ้าอ่าน QR ไม่ได้
// ponytail: เช็กได้แค่ "สลิปตรงกับที่แจ้ง + ไม่เคยใช้ซ้ำ" ไม่ได้ถามธนาคาร — สลิปปลอมที่ทำเนียนยังผ่านได้
//           ถ้าต้องการยืนยันกับธนาคารจริง ต้องใช้ API ตรวจสลิปแบบเสียเงิน (เช่น SlipOK / EasySlip)
const SlipBot = (() => {
  const load = (src) => new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => fail(new Error('โหลดบอทอ่านสลิปไม่สำเร็จ'));
    document.head.append(s);
  });
  let libs, worker;
  // โหลดตอนใช้ครั้งแรก (OCR ไฟล์ใหญ่ ไม่ให้หน้าเว็บช้าตอนเปิด)
  const ready = () => (libs ??= Promise.all([
    window.jsQR || load('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'),
    window.Tesseract || load('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'),
  ]));

  // QR สลิป = ข้อมูลแบบ TLV (แท็ก 2 หลัก + ความยาว 2 หลัก + ค่า) · เลขอ้างอิงอยู่ที่แท็ก 00 → 02
  function tlv(s) {
    const out = {};
    for (let i = 0; i + 4 <= s.length;) {
      const len = Number(s.slice(i + 2, i + 4));
      if (!Number.isInteger(len)) break;
      out[s.slice(i, i + 2)] = s.slice(i + 4, i + 4 + len);
      i += 4 + len;
    }
    return out;
  }
  const qrRef = (data) => {
    const root = tlv(data);
    return (root['00'] && tlv(root['00'])['02']) || null;
  };

  async function toCanvas(src) { // File/Blob หรือลิงก์รูป
    const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }

  // ขาว-ดำ: ลบพื้นสี/ลายน้ำจาง ๆ ของสลิป (เช่น mymo พื้นชมพู) ให้ OCR เห็นตัวเลขชัด
  function blackWhite(src, threshold = 170) {
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0);
    const im = g.getImageData(0, 0, c.width, c.height);
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < threshold ? 0 : 255;
    g.putImageData(im, 0, 0);
    return c;
  }

  // "88.00" / "1,250.00" / "THB500.00" → ตัวเลข · อย่างอื่น (วันที่ เวลา เลขบัญชี) → null
  const money = (t) => {
    const s = t.replace(/[Oo]/g, '0').replace(/[^\d.,]/g, '');
    return /^(\d{1,3}(,\d{3})+|\d+)\.\d{2}$/.test(s) ? Number(s.replace(/,/g, '')) : null;
  };

  async function ocr(c) {
    worker ??= Tesseract.createWorker('eng').then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: '11' }); // หาตัวหนังสือทุกจุด (สลิปไม่ได้เรียงเป็นย่อหน้า)
      return w;
    });
    const { data } = await (await worker).recognize(c);
    // ยอดโอน = ตัวเลขเงินที่ตัวใหญ่ที่สุดในสลิป (ค่าธรรมเนียม / ยอดอื่นตัวเล็กกว่า)
    const best = data.words.map((w) => ({ v: money(w.text), h: w.bbox.y1 - w.bbox.y0 })).filter((m) => m.v > 0)
      .sort((a, b) => b.h - a.h || b.v - a.v)[0];
    return { amount: best?.v ?? null, text: data.text };
  }

  // → { ref, refFrom: 'qr' | 'text' | null, amount }
  async function read(src) {
    await ready();
    const c = await toCanvas(src);
    const qr = jsQR(c.getContext('2d').getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    let r = await ocr(blackWhite(c));
    if (r.amount == null) r = await ocr(c); // สลิปพื้นเข้ม/ตัวอักษรสีอ่อน → ลองอ่านจากรูปเดิมอีกรอบ
    const fromQr = qr && qrRef(qr.data);
    const fromText = (r.text.toUpperCase().match(/\b[A-Z0-9]{12,40}\b/g) ?? []).filter((t) => /\d/.test(t)).sort((a, b) => b.length - a.length)[0];
    return { ref: fromQr || fromText || null, refFrom: fromQr ? 'qr' : fromText ? 'text' : null, amount: r.amount };
  }
  return { read, qrRef };
})();
