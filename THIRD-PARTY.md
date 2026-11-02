# Third-party components

## PdfBox-Android 2.0.27.0

ShelfScout uses PdfBox-Android to extract the text layer from a PDF for the
offline reading-aloud feature. The library is included as a compiled Android
archive and is not modified.

- Project: https://github.com/TomRoush/PdfBox-Android
- Based on Apache PDFBox: https://pdfbox.apache.org/
- License: Apache License 2.0
- Full license text: `android/libs/LICENSE-pdfbox.txt`
- Copyright: PdfBox-Android project contributors and the Apache Software Foundation

The library is used only on the phone. PDF text is processed locally and is
never sent to a server.
