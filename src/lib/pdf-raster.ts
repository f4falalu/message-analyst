// Browser-side PDF -> page images.
//
// Local runtimes (Ollama, LM Studio, llama.cpp) only accept images on their
// OpenAI-compatible endpoint; a `type: "file"` PDF block is rejected with
// "invalid message format". So the tab renders the pages itself and sends
// pictures instead.

const MAX_PAGES = 3;
const TARGET_WIDTH = 1400;

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
      pages.push(canvas.toDataURL("image/jpeg", 0.82));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  if (pages.length === 0) throw new Error("The PDF had no readable pages.");
  return pages;
}
