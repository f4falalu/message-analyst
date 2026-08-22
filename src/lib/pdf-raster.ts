// Browser-side PDF -> page images.
//
// Local runtimes (Ollama, LM Studio, llama.cpp) only accept images on their
// OpenAI-compatible endpoint; a `type: "file"` PDF block is rejected with
// "invalid message format". So the tab renders the pages itself and sends
// pictures instead.

const MAX_PAGES = 20;
const TARGET_WIDTH = 1240;
const JPEG_QUALITY = 0.72;
// Each PDF page is sent in its own request, so the budget per page is the
// relay ceiling (8 MB) minus prompt/context headroom. Base64 inflates bytes by
// ~4/3, so ~2.6M characters stays comfortably inside it while keeping enough
// resolution for hand-written scans to stay legible.
const MAX_PAGE_DATA_URL_CHARS = 2_600_000;


type PdfModule = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfModule> | null = null;

async function loadPdfjs(): Promise<PdfModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

function boundedJpegDataUrl(canvas: HTMLCanvasElement): string {
  let source = canvas;
  let quality = JPEG_QUALITY;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const url = source.toDataURL("image/jpeg", quality);
    if (url.length <= MAX_PAGE_DATA_URL_CHARS) return url;

    quality = Math.max(0.45, quality - 0.07);
    const resized = document.createElement("canvas");
    resized.width = Math.max(700, Math.floor(source.width * 0.85));
    resized.height = Math.max(700, Math.floor(source.height * 0.85));
    const context = resized.getContext("2d");
    if (!context) throw new Error("This browser could not resize the PDF page.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, resized.width, resized.height);
    context.drawImage(source, 0, 0, resized.width, resized.height);
    source = resized;
  }

  return source.toDataURL("image/jpeg", 0.42);
}


/** Render the first pages of a PDF as JPEG data URLs. */
export async function pdfToImageDataUrls(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pages: string[] = [];
  const count = Math.min(doc.numPages, MAX_PAGES);

  try {
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, Math.max(1, TARGET_WIDTH / base.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not render the PDF page.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      pages.push(boundedJpegDataUrl(canvas));
      page.cleanup();
    }
  } finally {
    await doc.cleanup();
  }

  if (pages.length === 0) throw new Error("The PDF had no readable pages.");
  return pages;
}
