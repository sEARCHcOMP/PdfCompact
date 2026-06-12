  async function detectBestMode(file) {
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const pagesToCheck = Math.min(pdf.numPages, 3);
      let totalTextLen = 0;
      for (let i = 1; i <= pagesToCheck; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        totalTextLen += tc.items.reduce((s, it) => s + (it.str || '').length, 0);
      }
      // Average > 200 chars per page suggests real text content
      return (totalTextLen / pagesToCheck) > 200 ? 'doc' : 'photo';
    } catch (e) {
      return 'photo';
    }
  }

  // DOC MODE: preserve text/vectors, only recompress embedded JPEG images
  async function compressPdfDocMode(fileObj, targetDpi, jpegQuality) {
    const { PDFDocument, PDFName, PDFRawStream, PDFNumber } = PDFLib;
    const arrayBuf = await fileObj.file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuf, { ignoreEncryption: false });

    // Collect image XObjects
    const imageEntries = [];
    const indirectObjects = pdfDoc.context.enumerateIndirectObjects();
    for (const [ref, obj] of indirectObjects) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      const subtype = dict.get(PDFName.of('Subtype'));
      if (!subtype || subtype.toString() !== '/Image') continue;
      imageEntries.push([ref, obj]);
    }

    fileObj.currentStep = `画像 0/${imageEntries.length}`;
    render();

    let processed = 0;
    let replaced = 0;

    // Target max image dimension: assume an image shown at most at full letter-size width
    // at target DPI: ~8.5 inches * DPI
    const maxDim = Math.round(targetDpi * 10);

    for (const [ref, obj] of imageEntries) {
      const dict = obj.dict;
      const filter = dict.get(PDFName.of('Filter'));
      const filterStr = filter ? filter.toString() : '';

      // Skip if has soft mask (transparency) - JPEG can't handle it
      const hasSMask = !!dict.get(PDFName.of('SMask'));

      // Only process pure JPEG (DCTDecode) images without SMask
      const isJpeg = filterStr === '/DCTDecode'
        || (filterStr.includes('DCTDecode') && !filterStr.includes('JBIG2'));

      if (!isJpeg || hasSMask) {
        processed++;
        continue;
      }

      try {
        const jpegBytes = obj.contents;
        // Skip tiny images (icons, bullets)
        if (jpegBytes.length < 5000) {
          processed++;
          continue;
        }

        const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
        const img = await createImageBitmap(blob);

        const maxCurrentDim = Math.max(img.width, img.height);
        const scale = maxCurrentDim > maxDim ? maxDim / maxCurrentDim : 1.0;

        const newW = Math.max(1, Math.round(img.width * scale));
        const newH = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = newW;
        canvas.height = newH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, newW, newH);
        ctx.drawImage(img, 0, 0, newW, newH);

        const newBlob = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', jpegQuality)
        );
        const newBytes = new Uint8Array(await newBlob.arrayBuffer());

        // Only replace if actually smaller
        if (newBytes.length < jpegBytes.length * 0.95) {
          // Build a new dict preserving entries but updating dimensions & length
          const newDict = pdfDoc.context.obj({});
          for (const [key, val] of dict.entries()) {
            const keyStr = key.toString();
            // Skip entries that become invalid after re-encoding
            if (keyStr === '/DecodeParms' || keyStr === '/Decode') continue;
            newDict.set(key, val);
          }
          newDict.set(PDFName.of('Width'), PDFNumber.of(newW));
          newDict.set(PDFName.of('Height'), PDFNumber.of(newH));
          newDict.set(PDFName.of('Length'), PDFNumber.of(newBytes.length));
          newDict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
          // canvas再エンコードJPEGは常にRGB(3成分)。元のColorSpace
          // (DeviceGray/DeviceCMYK等)をコピーすると色化けするため常にDeviceRGB
          newDict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
          newDict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));

          const newStream = PDFRawStream.of(newDict, newBytes);
          pdfDoc.context.assign(ref, newStream);
          replaced++;
        }

        // Cleanup
        canvas.width = 0;
        canvas.height = 0;
        img.close && img.close();
      } catch (e) {
        console.warn('image skipped:', e.message);
      }

      processed++;
      fileObj.progress = (processed / imageEntries.length) * 100;
      fileObj.currentStep = `書類モード: 画像 ${processed}/${imageEntries.length} (${replaced}枚再圧縮)`;
      render();
      await new Promise(r => setTimeout(r, 0));
    }

    const outBytes = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false
    });
    return { blob: new Blob([outBytes], { type: 'application/pdf' }) };
  }

  // PHOTO MODE: rasterize everything (old behavior, good for photo-heavy PDFs)
  async function compressPdfPhotoMode(fileObj, targetDpi, jpegQuality) {
    return compressPdf(fileObj, targetDpi, jpegQuality);
  }

  // Standalone blob compressor for reuse from other modules (e.g., PDF edit split)
  // Rasterizes each page → JPEG → embeds into new PDF (photo mode pipeline)
  async function compressPdfBlobPhotoMode(blob, targetDpi, jpegQuality, onProgress) {
    const { PDFDocument } = PDFLib;
    const arrayBuf = await blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf.slice(0) }).promise;
    const numPages = pdf.numPages;
    const renderScale = targetDpi / 72;
    const outDoc = await PDFDocument.create();

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      if (onProgress) onProgress(pageNum, numPages);
      const page = await pdf.getPage(pageNum);
      const renderViewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
      const base64 = dataUrl.split(',')[1];
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const jpgImage = await outDoc.embedJpg(bytes);

      // Page dimension in PDF points (72dpi basis), matching original page
      const baseVp = page.getViewport({ scale: 1 });
      const pdfPage = outDoc.addPage([baseVp.width, baseVp.height]);
      pdfPage.drawImage(jpgImage, { x: 0, y: 0, width: baseVp.width, height: baseVp.height });

      canvas.width = 0; canvas.height = 0;
      await new Promise(r => setTimeout(r, 0));
    }

    const outBytes = await outDoc.save({ useObjectStreams: true });
    return new Blob([outBytes], { type: 'application/pdf' });
  }

  // PHOTO MODE + OCR: rasterize + add invisible searchable text layer via Tesseract
  async function compressPdfPhotoModeOCR(fileObj, targetDpi, jpegQuality, lang) {
    const { PDFDocument } = PDFLib;

    // Initialize worker (cached across files in same batch)
    if (!ocrWorker || ocrWorker._lang !== lang) {
      if (ocrWorker) {
        try { await ocrWorker.terminate(); } catch (e) {}
      }
      fileObj.currentStep = 'OCR辞書をダウンロード中...';
      render();
      const langList = lang.split('+');
      ocrWorker = await Tesseract.createWorker(langList, 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            fileObj.currentStep = `OCR認識中 ${Math.round(m.progress * 100)}%`;
            render();
          } else if (m.status && m.status.includes('loading')) {
            fileObj.currentStep = `辞書ロード中 ${Math.round(m.progress * 100)}%`;
            render();
          }
        }
      });
      ocrWorker._lang = lang;
    }

    const arrayBuf = await fileObj.file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    const numPages = pdf.numPages;
    const renderScale = targetDpi / 72;

    const outDoc = await PDFDocument.create();

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      fileObj.currentStep = `ページ ${pageNum}/${numPages} - 描画`;
      render();

      const page = await pdf.getPage(pageNum);
      const renderViewport = page.getViewport({ scale: renderScale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      // Compress canvas to JPEG first (for smaller input to Tesseract's PDF embedder)
      const jpegBlob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', jpegQuality)
      );

      fileObj.currentStep = `ページ ${pageNum}/${numPages} - OCR`;
      render();

      // Run OCR with PDF output
      const ocrResult = await ocrWorker.recognize(
        jpegBlob,
        {},
        { pdf: true }
      );

      const ocrPdfBytes = new Uint8Array(ocrResult.data.pdf);
      const ocrPdf = await PDFDocument.load(ocrPdfBytes);
      const [copiedPage] = await outDoc.copyPages(ocrPdf, [0]);
      // Tesseract はDPI不明のJPEGを70dpi扱いするため、OCR結果PDFのページ寸法が
      // 元より膨張する (px × 72/70)。元ページのpt寸法 (72dpi基準) に戻す。
      // scale() はコンテンツ・MediaBox・注釈を一括スケールするので透明テキスト層の位置関係も保たれる
      const baseVp = page.getViewport({ scale: 1 });
      const sx = baseVp.width / copiedPage.getWidth();
      const sy = baseVp.height / copiedPage.getHeight();
      if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) {
        copiedPage.scale(sx, sy);
      }
      outDoc.addPage(copiedPage);

      // cleanup
      canvas.width = 0;
      canvas.height = 0;

      fileObj.progress = (pageNum / numPages) * 100;
      render();
      await new Promise(r => setTimeout(r, 0));
    }

    const outBytes = await outDoc.save({ useObjectStreams: true });
    return { blob: new Blob([outBytes], { type: 'application/pdf' }) };
  }

  async function compressPdf(fileObj, targetDpi, jpegQuality) {
    const arrayBuf = await fileObj.file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    const numPages = pdf.numPages;
    const renderScale = targetDpi / 72;

    let outPdf = null;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const renderViewport = page.getViewport({ scale: renderScale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      const ctx = canvas.getContext('2d');
      // White background to avoid transparent → black on JPEG
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      const jpegDataUrl = canvas.toDataURL('image/jpeg', jpegQuality);

      // Use original page size in points for the output PDF
      const pw = baseViewport.width;
      const ph = baseViewport.height;
      const orientation = pw > ph ? 'landscape' : 'portrait';

      if (pageNum === 1) {
        outPdf = new jsPDF({
          orientation: orientation,
          unit: 'pt',
          format: [pw, ph],
          compress: true
        });
      } else {
        outPdf.addPage([pw, ph], orientation);
      }
      outPdf.addImage(jpegDataUrl, 'JPEG', 0, 0, pw, ph, undefined, 'FAST');

      // cleanup
      canvas.width = 0;
      canvas.height = 0;

      fileObj.progress = (pageNum / numPages) * 100;
      fileObj.currentStep = `${pageNum}/${numPages}ページ`;
      render();
      // Yield to UI
      await new Promise(r => setTimeout(r, 0));
    }

    const blob = outPdf.output('blob');
    return { blob };
  }


  // =========================================================
  // FILENAME TIMESTAMP TOGGLE — shared helpers
  // =========================================================
  // state lives on the button element as data-ts-enabled
