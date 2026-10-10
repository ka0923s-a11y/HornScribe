//! #113: one-click PDF — CoreWebView2.PrintToPdf, no OS print dialog.
//!
//! The frontend mounts the .hs-print-pages surface (the same A4-paged
//! markup the Ctrl+P path renders; the print CSS hides the app chrome)
//! and then calls this command. WebView2 renders the page under print
//! media rules straight to path — the OS dialog never appears.
//!
//! PrintToPdf is an async COM call: the tauri command runs on a worker
//! thread, with_webview dispatches the COM setup to the UI thread, and
//! the completed handler reports back over an mpsc channel while the
//! normal message pump keeps the UI responsive.

#[cfg(windows)]
mod imp {
    use std::sync::mpsc;
    use std::time::Duration;

    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, PCWSTR, HSTRING};

    /// Write the current page (as laid out under print media) to a PDF
    /// file. The caller picks the path via export::score_pdf_path, which
    /// also grants its parent directory; we re-check the grant so an
    /// arbitrary webview-side invoke cannot write outside picked dirs.
    pub fn print_to_pdf(
        app: &tauri::AppHandle,
        window: WebviewWindow,
        path: String,
    ) -> Result<(), String> {
        let file = std::path::PathBuf::from(&path);
        let parent = file
            .parent()
            .ok_or_else(|| "pdf path has no parent directory".to_string())?;
        if !crate::export::dir_allowed(app, parent) {
            return Err("pdf path is outside an allowed directory".into());
        }
        if file
            .extension()
            .map(|e| e.eq_ignore_ascii_case("pdf"))
            != Some(true)
        {
            return Err("pdf path must end in .pdf".into());
        }

        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let tx_invoke = tx.clone();
        window
            .with_webview(move |webview| {
                let run = (|| -> Result<(), String> {
                    let core = unsafe { webview.controller().CoreWebView2() }
                        .map_err(|e| format!("CoreWebView2: {e}"))?;
                    // PrintToPdf needs runtime >= 89.0.774.63; the cast
                    // fails honestly on an older runtime.
                    let wv7: ICoreWebView2_7 = core
                        .cast()
                        .map_err(|e| format!("ICoreWebView2_7: {e}"))?;
                    let env6: ICoreWebView2Environment6 = webview
                        .environment()
                        .cast()
                        .map_err(|e| format!("ICoreWebView2Environment6: {e}"))?;
                    let settings = unsafe { env6.CreatePrintSettings() }
                        .map_err(|e| format!("CreatePrintSettings: {e}"))?;
                    unsafe {
                        settings
                            .SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)
                            .map_err(|e| e.to_string())?;
                        // A4 in inches — the @page margin:0 rule owns the
                        // real margin via .hs-print-page padding, so the
                        // webview must not add a second one.
                        settings
                            .SetPageWidth(8.27)
                            .map_err(|e| e.to_string())?;
                        settings
                            .SetPageHeight(11.69)
                            .map_err(|e| e.to_string())?;
                        settings
                            .SetMarginTop(0.0)
                            .map_err(|e| e.to_string())?;
                        settings
                            .SetMarginBottom(0.0)
                            .map_err(|e| e.to_string())?;
                        settings
                            .SetMarginLeft(0.0)
                            .map_err(|e| e.to_string())?;
                        settings
                            .SetMarginRight(0.0)
                            .map_err(|e| e.to_string())?;
                        settings
                            .SetShouldPrintHeaderAndFooter(false)
                            .map_err(|e| e.to_string())?;
                        settings
                            .SetShouldPrintSelectionOnly(false)
                            .map_err(|e| e.to_string())?;
                        settings
                            .SetShouldPrintBackgrounds(true)
                            .map_err(|e| e.to_string())?;
                    }
                    let wide = HSTRING::from(path.as_str());
                    let handler = PrintToPdfCompletedHandler::create(Box::new(
                        move |result: windows::core::Result<()>, ok: bool| {
                            let _ = tx.send(match result {
                                Ok(()) if ok => Ok(()),
                                Ok(()) => {
                                    Err("PrintToPdf reported unsuccessful".into())
                                }
                                Err(e) => Err(format!("PrintToPdf: {e}")),
                            });
                            Ok(())
                        },
                    ));
                    unsafe {
                        wv7.PrintToPdf(
                            PCWSTR::from_raw(wide.as_ptr()),
                            &settings,
                            &handler,
                        )
                    }
                    .map_err(|e| format!("PrintToPdf call: {e}"))
                })();
                if let Err(e) = run {
                    let _ = tx_invoke.send(Err(e));
                }
            })
            .map_err(|e| format!("with_webview: {e}"))?;
        rx.recv_timeout(Duration::from_secs(120))
            .map_err(|e| format!("PrintToPdf did not finish: {e}"))?
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn print_to_pdf(
        _app: &tauri::AppHandle,
        _window: tauri::WebviewWindow,
        _path: String,
    ) -> Result<(), String> {
        Err("PDF direct save is only supported on Windows".into())
    }
}

/// Tauri entry point (see module docs).
#[tauri::command(async)]
pub fn print_to_pdf(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    imp::print_to_pdf(&app, window, path)
}
