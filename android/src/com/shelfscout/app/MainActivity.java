package com.shelfscout.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * ShelfScout for Android.
 *
 * The full web app ships inside the APK and is served to the WebView from an
 * https origin, so the app runs with no server, keeps its books on the phone,
 * and still counts as a secure context (the camera works).
 *
 * It can also point at ShelfScout running on a computer; long-press to change.
 */
public class MainActivity extends Activity {
  private static final String PREFS = "shelfscout";
  private static final String KEY_URL = "server_url";
  private static final int MATCH = ViewGroup.LayoutParams.MATCH_PARENT;
  private static final int FILE_PICK = 9;

  // Wanted by the backup screen when it imports a JSON file.
  private ValueCallback<Uri[]> fileCallback;

  // Fake https host backed by assets/www. Using https (not file://) keeps the
  // page a secure context, which getUserMedia requires for the barcode camera.
  private static final String APP_HOST = "appassets.androidplatform.net";
  private static final String APP_URL = "https://" + APP_HOST + "/index.html";

  private static final long RETRY_MS = 15000;

  private SharedPreferences prefs;
  private FrameLayout root;
  private WebView web;
  private String currentUrl = "";
  private String serverTarget = "";
  private final Handler retryHandler = new Handler(Looper.getMainLooper());
  private boolean retrying;
  private boolean inSetup;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    root = new FrameLayout(this);
    root.setBackgroundColor(Color.parseColor("#14120F"));
    setContentView(root);

    // Open the bundled shelf at once, then switch to the live server as soon
    // as it answers. That keeps the app usable with no server and makes it go
    // Live on its own when the server comes back.
    serverTarget = preferredServer();
    showWeb(APP_URL);
    if (!serverTarget.isEmpty()) startServerRetry(1200);
  }

  /** The saved link wins; otherwise the address baked in at build time. */
  private String preferredServer() {
    String saved = prefs.getString(KEY_URL, "");
    if (!saved.isEmpty()) return saved;
    if (!prefs.getBoolean("auto_server", true)) return "";
    return bakedServerUrl();
  }

  /** Written by the build from the permanent link, so every install knows it. */
  private String bakedServerUrl() {
    try (InputStream in = getAssets().open("www/serverurl.txt")) {
      byte[] buffer = new byte[512];
      int read = in.read(buffer);
      if (read <= 0) return "";
      String url = new String(buffer, 0, read, StandardCharsets.UTF_8).trim();
      if (!url.startsWith("https://") && !url.startsWith("http://")) return "";
      return url.replaceAll("/+$", "");
    } catch (Exception e) {
      return "";
    }
  }

  /** Checks the server while the phone shows its own copy, then switches. */
  private void startServerRetry(long delay) {
    if (serverTarget.isEmpty() || retrying || inSetup || !APP_URL.equals(currentUrl)) return;
    retrying = true;
    retryHandler.postDelayed(serverCheck, delay);
  }

  private void stopServerRetry() {
    retrying = false;
    retryHandler.removeCallbacks(serverCheck);
  }

  private final Runnable serverCheck = new Runnable() {
    @Override
    public void run() {
      final String target = serverTarget;
      if (!retrying || target.isEmpty() || !APP_URL.equals(currentUrl)) {
        retrying = false;
        return;
      }
      new Thread(() -> {
        boolean ok = serverHealthy(target);
        runOnUiThread(() -> {
          if (!retrying) return;
          if (ok && APP_URL.equals(currentUrl) && target.equals(serverTarget)) {
            retrying = false;
            showWeb(target);
          } else {
            retryHandler.postDelayed(serverCheck, RETRY_MS);
          }
        });
      }, "shelfscout-server-check").start();
    }
  };

  private static boolean serverHealthy(String base) {
    HttpURLConnection conn = null;
    try {
      conn = (HttpURLConnection) new URL(base + "/api/health").openConnection();
      conn.setInstanceFollowRedirects(true);
      conn.setConnectTimeout(4000);
      conn.setReadTimeout(4000);
      conn.setRequestProperty("User-Agent", "ShelfScout");
      return conn.getResponseCode() == 200;
    } catch (Exception e) {
      return false;
    } finally {
      if (conn != null) conn.disconnect();
    }
  }

  /** The server went away: keep working on this phone and keep checking. */
  private void fallbackToDevice() {
    if (APP_URL.equals(currentUrl)) return;
    showWeb(APP_URL);
    startServerRetry(4000);
  }

  private void useDeviceOnly() {
    prefs.edit().remove(KEY_URL).putBoolean("auto_server", false).apply();
    serverTarget = "";
    stopServerRetry();
    showWeb(APP_URL);
  }

  private void connectTo(String url) {
    prefs.edit().putString(KEY_URL, url).putBoolean("auto_server", true).apply();
    serverTarget = url;
    stopServerRetry();
    showWeb(url);
  }

  private int dp(int value) {
    return Math.round(getResources().getDisplayMetrics().density * value);
  }

  /* ---------------- bundled and updated files ---------------- */

  /** Downloaded app files live here; the APK copy is the fallback. */
  private File webRoot() {
    return new File(getFilesDir(), "www");
  }

  private WebResourceResponse asset(String path) {
    if (path.contains("..")) return notFound();
    String rel = path.startsWith("/") ? path.substring(1) : path;

    // A downloaded bundle wins over the copy inside the APK.
    File file = new File(webRoot(), rel);
    try {
      if (file.isFile()) return stream(file.getPath(), new FileInputStream(file));
    } catch (Exception e) {
      /* fall back to the bundled file */
    }

    try {
      return stream(path, getAssets().open("www" + path));
    } catch (IOException e) {
      return notFound();
    }
  }

  // no-cache stops a freshly updated bundle from being served stale.
  private WebResourceResponse stream(String path, InputStream in) {
    String mime = mimeOf(path);
    String encoding = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") ? "utf-8" : null;
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-cache");
    return new WebResourceResponse(mime, encoding, 200, "OK", headers, in);
  }

  private void deleteTree(File file) {
    if (file == null || !file.exists()) return;
    File[] children = file.listFiles();
    if (children != null) for (File child : children) deleteTree(child);
    file.delete();
  }

  /** Phone library, computer link and app-file reset. Shown from the web footer. */
  private void showAppMenu() {
    String[] options = {"Connect to computer", "Use this phone", "Reset app files", "Cancel"};
    new AlertDialog.Builder(this)
        .setTitle("ShelfScout")
        .setMessage("This app works on its own. You can also connect it to ShelfScout running on your computer.")
        .setItems(options, (dialog, which) -> {
          if (which == 0) {
            stopServerRetry();
            serverTarget = "";
            showSetup();
          } else if (which == 1) {
            useDeviceOnly();
          } else if (which == 2) {
            deleteTree(webRoot());
            showWeb(serverTarget.isEmpty() ? APP_URL : serverTarget);
            if (APP_URL.equals(currentUrl)) startServerRetry(1500);
          }
        })
        .show();
  }

  private WebResourceResponse notFound() {
    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null,
        new ByteArrayInputStream("Not found".getBytes()));
  }

  private static String mimeOf(String path) {
    String p = path.toLowerCase();
    if (p.endsWith(".html")) return "text/html";
    if (p.endsWith(".css")) return "text/css";
    if (p.endsWith(".js")) return "application/javascript";
    if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
    if (p.endsWith(".png")) return "image/png";
    if (p.endsWith(".svg")) return "image/svg+xml";
    if (p.endsWith(".ico")) return "image/x-icon";
    return "application/octet-stream";
  }

  /* ---------------- first run / change link ---------------- */

  private void showSetup() {
    stopServerRetry();
    inSetup = true;
    web = null;

    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setGravity(Gravity.CENTER);
    box.setPadding(dp(28), dp(28), dp(28), dp(28));

    TextView title = new TextView(this);
    title.setText("ShelfScout");
    title.setTextColor(Color.parseColor("#F2EBDF"));
    title.setTextSize(32);
    title.setTypeface(Typeface.create("serif", Typeface.BOLD));
    title.setGravity(Gravity.CENTER);

    TextView help = new TextView(this);
    help.setText("ShelfScout works on this phone with no computer.\n\nTo use the library from your computer instead, paste the link printed in its terminal, for example https://your-name.ngrok-free.app");
    help.setTextColor(Color.parseColor("#C9B79B"));
    help.setTextSize(14);
    help.setGravity(Gravity.CENTER);
    help.setPadding(0, dp(14), 0, dp(20));

    EditText input = new EditText(this);
    input.setHint("https://your-name.ngrok-free.app");
    input.setSingleLine(true);
    input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    input.setTextColor(Color.parseColor("#F2EBDF"));
    input.setHintTextColor(Color.parseColor("#8C7E69"));

    Button connect = new Button(this);
    connect.setText("Connect to computer");
    connect.setTextColor(Color.parseColor("#2A1D0E"));
    connect.setBackgroundColor(Color.parseColor("#D9A15C"));

    TextView error = new TextView(this);
    error.setTextColor(Color.parseColor("#F0857A"));
    error.setGravity(Gravity.CENTER);
    error.setPadding(0, dp(10), 0, 0);

    Button onDevice = new Button(this);
    onDevice.setText("Use the library on this phone");
    onDevice.setTextColor(Color.parseColor("#F2EBDF"));
    onDevice.setBackgroundColor(Color.parseColor("#3A3226"));
    onDevice.setOnClickListener(v -> useDeviceOnly());

    connect.setOnClickListener(v -> {
      String url = normalize(input.getText().toString());
      if (url == null) {
        error.setText("That doesn't look like a link - it should start with https://");
        return;
      }
      connectTo(url);
    });

    box.addView(title);
    box.addView(help);
    box.addView(input);
    box.addView(connect);
    box.addView(onDevice);
    box.addView(error);

    root.removeAllViews();
    root.addView(box, new FrameLayout.LayoutParams(MATCH, MATCH));
  }

  private static boolean isPdfUrl(String url) {
    if (url == null) return false;
    String clean = url.split("[?#]")[0].toLowerCase();
    return clean.endsWith(".pdf") || clean.contains("/pdfs/");
  }

  private void openPdfInApp(String url, String bookId, String title) {
    openPdfInApp(url, bookId, title, false);
  }

  private void openPdfInApp(String url, String bookId, String title, boolean listen) {
    if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
    Intent intent = new Intent(MainActivity.this, PdfActivity.class);
    intent.putExtra(PdfActivity.EXTRA_URL, url);
    intent.putExtra(PdfActivity.EXTRA_BOOK, bookId == null ? "" : bookId);
    intent.putExtra(PdfActivity.EXTRA_TITLE, title == null ? "" : title);
    intent.putExtra(PdfActivity.EXTRA_LISTEN, listen);
    runOnUiThread(() -> startActivity(intent));
  }

  private String normalize(String raw) {
    String url = raw == null ? "" : raw.trim();
    if (url.isEmpty()) return null;
    if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
    if (!url.contains(".")) return null;
    return url.replaceAll("/+$", "");
  }

  /* ---------------- the app window ---------------- */

  private void showWeb(String url) {
    currentUrl = url;
    inSetup = false;
    if (!APP_URL.equals(url)) stopServerRetry();
    FrameLayout wrap = new FrameLayout(this);

    web = new WebView(this);
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setUseWideViewPort(true);
    settings.setLoadWithOverviewMode(true);
    settings.setAllowFileAccess(false);
    settings.setUserAgentString(settings.getUserAgentString() + " ShelfScout/1.5");

    // The web app reads the installed version here and saves backups through
    // saveFile().
    web.addJavascriptInterface(new VersionBridge(), "ShelfApp");

    // A tapped APK link must leave the WebView and go to the browser.
    web.setDownloadListener((apkUrl, userAgent, contentDisposition, mimeType, contentLength) -> {
      try {
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl)));
      } catch (Exception ignored) {
        /* no browser available */
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(final PermissionRequest request) {
        runOnUiThread(() -> {
          if (checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(request.getResources());
          } else {
            request.deny();
          }
        });
      }

      // Without this the <input type="file"> in the backup screen does nothing.
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        try {
          startActivityForResult(params.createIntent(), FILE_PICK);
          return true;
        } catch (Exception e) {
          fileCallback = null;
          return false;
        }
      }
    });

    LinearLayout errorPanel = new LinearLayout(this);
    errorPanel.setOrientation(LinearLayout.VERTICAL);
    errorPanel.setGravity(Gravity.CENTER);
    errorPanel.setBackgroundColor(Color.parseColor("#F214120F"));
    errorPanel.setVisibility(View.GONE);

    TextView message = new TextView(this);
    message.setText("Can't reach ShelfScout on the computer.\n\nCheck that it is running and the link is correct, or use the library stored on this phone.");
    message.setTextColor(Color.parseColor("#F2EBDF"));
    message.setTextSize(16);
    message.setGravity(Gravity.CENTER);
    message.setPadding(dp(28), dp(28), dp(28), dp(20));

    Button retry = new Button(this);
    retry.setText("Try again");
    retry.setTextColor(Color.parseColor("#2A1D0E"));
    retry.setBackgroundColor(Color.parseColor("#D9A15C"));
    retry.setOnClickListener(v -> {
      errorPanel.setVisibility(View.GONE);
      web.loadUrl(currentUrl);
    });

    Button onDevice = new Button(this);
    onDevice.setText("Use the library on this phone");
    onDevice.setTextColor(Color.parseColor("#F2EBDF"));
    onDevice.setBackgroundColor(Color.parseColor("#3A3226"));
    onDevice.setOnClickListener(v -> {
      errorPanel.setVisibility(View.GONE);
      useDeviceOnly();
    });

    Button relink = new Button(this);
    relink.setText("Change link");
    relink.setTextColor(Color.parseColor("#F2EBDF"));
    relink.setBackgroundColor(Color.parseColor("#262119"));
    relink.setOnClickListener(v -> {
      stopServerRetry();
      serverTarget = "";
      showSetup();
    });

    errorPanel.addView(message);
    errorPanel.addView(retry);
    errorPanel.addView(onDevice);
    errorPanel.addView(relink);

    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null || !APP_HOST.equals(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || path.equals("/")) path = "/index.html";
        return asset(path);
      }

      // Any PDF the page tries to navigate to stays in the app.
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        String target = uri == null ? null : uri.toString();
        if (isPdfUrl(target)) {
          openPdfInApp(target, "", "PDF");
          return true;
        }
        return false;
      }

      @Override
      public void onPageFinished(WebView view, String finishedUrl) {
        errorPanel.setVisibility(View.GONE);
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame()) return;
        if (!APP_URL.equals(currentUrl) && !serverTarget.isEmpty()) {
          fallbackToDevice();
        } else {
          errorPanel.setVisibility(View.VISIBLE);
        }
      }

      // ngrok answers with an HTTP error page when the tunnel is down, which is
      // not a network error, so treat it as the server being away too.
      @Override
      public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (!request.isForMainFrame()) return;
        if (response.getStatusCode() >= 400 && !APP_URL.equals(currentUrl) && !serverTarget.isEmpty()) {
          fallbackToDevice();
        }
      }
    });

    // Long-press is deliberately left to the WebView. A listener here swallowed
    // every long press, so text fields could never show Select / Paste. App
    // options now live behind the footer's App settings button.


    wrap.addView(web, new FrameLayout.LayoutParams(MATCH, MATCH));
    wrap.addView(errorPanel, new FrameLayout.LayoutParams(MATCH, MATCH));

    root.removeAllViews();
    root.addView(wrap, new FrameLayout.LayoutParams(MATCH, MATCH));

    web.loadUrl(url);
    requestCamera();
  }

  private void requestCamera() {    if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{android.Manifest.permission.CAMERA}, 7);
    }
  }

  /** Installed version for the update check, plus a way to save a backup file. */
  public class VersionBridge {
    @JavascriptInterface
    public int versionCode() {
      try {
        PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
        if (Build.VERSION.SDK_INT >= 28) return (int) (info.getLongVersionCode() & 0x7FFFFFFFL);
        return info.versionCode;
      } catch (Exception e) {
        return 0;
      }
    }

    /** Which app files this phone has: downloaded bundle, else the APK copy. */
    @JavascriptInterface
    public int webVersion() {
      int stored = versionFromFile(new File(webRoot(), "webversion.txt"));
      if (stored > 0) return stored;
      try {
        return versionFromStream(getAssets().open("www/webversion.txt"));
      } catch (IOException e) {
        return 0;
      }
    }

    private int versionFromFile(File file) {
      try {
        return versionFromStream(new FileInputStream(file));
      } catch (Exception e) {
        return 0;
      }
    }

    private int versionFromStream(InputStream in) {
      try {
        byte[] buf = new byte[24];
        int n = in.read(buf);
        in.close();
        if (n <= 0) return 0;
        return Integer.parseInt(new String(buf, 0, n, StandardCharsets.UTF_8).trim());
      } catch (Exception e) {
        return 0;
      }
    }

    /** Downloads the current web bundle and swaps it in. Returns "ok" on success. */
    @JavascriptInterface
    public String installWebUpdate(String url, int version) {
      if (url == null || !url.startsWith("https://github.com/Ojaswi03/BookRecords/releases/")) return "bad url";
      File tmp = new File(getCacheDir(), "web-update");
      deleteTree(tmp);
      if (!tmp.mkdirs()) return "no storage";
      HttpURLConnection conn = null;
      try {
        conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        conn.setRequestProperty("User-Agent", "ShelfScout");
        if (conn.getResponseCode() != 200) return "download " + conn.getResponseCode();

        String base = tmp.getCanonicalPath() + File.separator;
        ZipInputStream zip = new ZipInputStream(new BufferedInputStream(conn.getInputStream()));
        byte[] buf = new byte[8192];
        long total = 0;
        ZipEntry entry;
        while ((entry = zip.getNextEntry()) != null) {
          String name = entry.getName();
          if (name.contains("..") || name.startsWith("/")) return "bad bundle";
          File out = new File(tmp, name);
          if (!out.getCanonicalPath().startsWith(base)) return "bad bundle";
          if (entry.isDirectory()) {
            out.mkdirs();
            continue;
          }
          File parent = out.getParentFile();
          if (parent != null) parent.mkdirs();
          FileOutputStream fos = new FileOutputStream(out);
          int n;
          while ((n = zip.read(buf)) > 0) {
            total += n;
            if (total > 30L * 1024 * 1024) {
              fos.close();
              return "bundle too big";
            }
            fos.write(buf, 0, n);
          }
          fos.close();
        }
        zip.close();

        File root = webRoot();
        deleteTree(root);
        if (!tmp.renameTo(root)) return "could not install";

        // The bundle carries webversion.txt; fall back to the release number.
        File marker = new File(root, "webversion.txt");
        if (!marker.exists() && version > 0) {
          FileOutputStream fos = new FileOutputStream(marker);
          fos.write(String.valueOf(version).getBytes(StandardCharsets.UTF_8));
          fos.close();
        }
        return "ok";
      } catch (Exception e) {
        return "failed";
      } finally {
        if (conn != null) conn.disconnect();
        deleteTree(tmp);
      }
    }

    /** Opens the PDF in ShelfScout's own reader. */
    @JavascriptInterface
    public void openPdf(String url, String bookId, String title) {
      openPdfInApp(url, bookId, title);
    }

    /** Opens the reader and asks for a voice, for the offline Listen button. */
    @JavascriptInterface
    public void listenPdf(String url, String bookId, String title) {
      boolean audio = getSharedPreferences("shelfscout_features", MODE_PRIVATE)
          .getBoolean("audiobook", false);
      openPdfInApp(url, bookId, title, audio);
    }

    /**
     * Feature flags from the web app. Read aloud can be switched off in the
     * developer panel, and the reader hides its Listen button to match.
     */
    @JavascriptInterface
    public void setFeatures(String json) {
      boolean audio = false;
      try {
        audio = new JSONObject(json == null ? "{}" : json).optBoolean("audiobook", false);
      } catch (Exception ignored) {
        /* malformed flags keep the safe default */
      }
      getSharedPreferences("shelfscout_features", MODE_PRIVATE).edit()
          .putBoolean("audiobook", audio).apply();
    }

    /** How far this book has been read, for the book screen and progress bar. */
    @JavascriptInterface
    public String readProgress(String bookId, String url) {
      return PdfActivity.readProgress(MainActivity.this, bookId, url);
    }

    /** App options, reachable without long-press so paste keeps working. */
    @JavascriptInterface
    public void appMenu() {
      runOnUiThread(MainActivity.this::showAppMenu);
    }

    /** Drops cached files that belong to a deleted book. */
    @JavascriptInterface
    public void deleteBookData(String bookId) {
      AudioPlaybackService.stopForBook(MainActivity.this, bookId);
      PdfActivity.deleteCache(MainActivity.this, bookId);
    }

    /**
     * Last-resort link opener. A PDF still goes to the in-app reader, so an
     * older web bundle can never push reading out to Chrome.
     */
    @JavascriptInterface
    public void openExternal(String url) {
      if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
      if (isPdfUrl(url)) {
        openPdfInApp(url, "", "PDF");
        return;
      }
      try {
        runOnUiThread(() -> {
          try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
          } catch (Exception ignored) {
            /* no app can open it */
          }
        });
      } catch (Exception ignored) {
        /* no app can open it */
      }
    }

    /** Writes an exported library to Downloads and returns where it landed. */
    @JavascriptInterface
    public String saveFile(String name, String content) {
      String safe = String.valueOf(name == null ? "shelfscout.json" : name).replaceAll("[^A-Za-z0-9._-]", "-");
      byte[] bytes = String.valueOf(content == null ? "" : content).getBytes(StandardCharsets.UTF_8);
      String mime = safe.endsWith(".csv") ? "text/csv" : "application/json";
      try {
        if (Build.VERSION.SDK_INT >= 29) {
          ContentValues values = new ContentValues();
          values.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
          values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
          values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ShelfScout");
          Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
          if (uri == null) return "";
          OutputStream out = getContentResolver().openOutputStream(uri);
          if (out == null) return "";
          out.write(bytes);
          out.close();
          return "Downloads/ShelfScout/" + safe;
        }
        File dir = new File(getExternalFilesDir(null), "exports");
        if (!dir.exists() && !dir.mkdirs()) return "";
        File file = new File(dir, safe);
        FileOutputStream out = new FileOutputStream(file);
        out.write(bytes);
        out.close();
        return file.getAbsolutePath();
      } catch (Exception e) {
        return "";
      }
    }
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode != FILE_PICK) {
      super.onActivityResult(requestCode, resultCode, data);
      return;
    }
    Uri[] result = null;
    if (resultCode == RESULT_OK && data != null) {
      if (data.getData() != null) {
        result = new Uri[]{ data.getData() };
      } else if (data.getClipData() != null) {
        int count = data.getClipData().getItemCount();
        result = new Uri[count];
        for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
      }
    }
    if (fileCallback != null) {
      fileCallback.onReceiveValue(result);
      fileCallback = null;
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    // Coming back to the app: try the server again so Live returns by itself.
    if (APP_URL.equals(currentUrl) && !serverTarget.isEmpty()) startServerRetry(800);
  }

  @Override
  protected void onPause() {
    stopServerRetry();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    stopServerRetry();
    super.onDestroy();
  }

  @Override
  public void onBackPressed() {
    if (web != null && web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }
}
