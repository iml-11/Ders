// Dosyalardan metin / görsel çıkarma (PDF, DOCX, TXT, MD, görseller)

const MAX_IMAGE_SIDE = 1600;
const MAX_SCANNED_PAGES = 12;

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Görsel açılamadı'));
    img.src = src;
  });
}

// Görseli küçültüp JPEG'e çevirir (depolama ve API boyutu için)
async function compressImage(src) {
  const img = await loadImage(src);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function extractPdf(file) {
  if (!window.pdfjsLib) throw new Error('PDF okuyucu yüklenemedi (internet bağlantısını kontrol et).');
  const data = await readAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let lastY = null;
    let text = '';
    for (const item of content.items) {
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n';
      else if (text && !text.endsWith(' ')) text += ' ';
      text += item.str;
      lastY = y;
    }
    pages.push(text.trim());
  }
  const text = pages.map((t, i) => `--- Sayfa ${i + 1} ---\n${t}`).join('\n\n');
  const charCount = pages.join('').replace(/\s/g, '').length;

  // Taranmış (metinsiz) PDF ise sayfaları görsele çevir
  const images = [];
  if (charCount < 20 * pdf.numPages) {
    const n = Math.min(pdf.numPages, MAX_SCANNED_PAGES);
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, MAX_IMAGE_SIDE / Math.max(vp1.width, vp1.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      images.push(canvas.toDataURL('image/jpeg', 0.8));
    }
    return {
      text: charCount > 0 ? text : '',
      images,
      note: `taranmış PDF: ${n} sayfa görsel olarak eklendi${pdf.numPages > n ? ` (ilk ${n})` : ''}`,
    };
  }
  return { text, images, note: `${pdf.numPages} sayfa` };
}

async function extractDocx(file) {
  if (!window.mammoth) throw new Error('Word okuyucu yüklenemedi (internet bağlantısını kontrol et).');
  const arrayBuffer = await readAsArrayBuffer(file);
  const result = await mammoth.extractRawText({ arrayBuffer });
  return { text: result.value.trim(), images: [] };
}

async function extractHtml(file) {
  const html = await file.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return { text: (doc.body?.innerText || doc.body?.textContent || '').trim(), images: [] };
}

/**
 * Bir dosyadan { text, images, note } çıkarır.
 */
async function extractFile(file) {
  const name = file.name.toLowerCase();
  const type = file.type || '';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return extractPdf(file);
  if (name.endsWith('.docx')) return extractDocx(file);
  if (name.endsWith('.doc')) throw new Error('Eski .doc biçimi desteklenmiyor; dosyayı .docx veya PDF olarak kaydet.');
  if (type.startsWith('image/')) {
    const url = await readAsDataURL(file);
    return { text: '', images: [await compressImage(url)], note: 'görsel' };
  }
  if (name.endsWith('.html') || name.endsWith('.htm')) return extractHtml(file);
  // Diğer her şeyi düz metin olarak dene
  return { text: (await file.text()).trim(), images: [] };
}

window.Files = { extractFile };
