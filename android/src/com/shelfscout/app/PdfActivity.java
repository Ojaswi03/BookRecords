package com.shelfscout.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.pdf.PdfRenderer;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * Reads a book's free PDF without leaving ShelfScout.
 *
 * The file is downloaded once into the app cache, rendered with Android's own
 * PdfRenderer, and deleted with the book. Page images are recycled as you move,
 * so a long book does not fill memory.
 */
public class PdfActivity extends Activity {
  public static final String EXTRA_URL = "url";
  public static final String EXTRA_TITLE = "title";
  public static final String EXTRA_BOOK = "book";

  private PdfRenderer renderer;
  private ParcelFileDescriptor descriptor;
  private ImageView image;
  private TextView counter;
  private Button prev;
  private Button next;
  private int pageIndex = 0;
  private Bitmap pageBitmap;
  private SharedPreferences reading;
  private String positionKey = "";

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);

    String url = getIntent().getStringExtra(EXTRA_URL);
    String title = getIntent().getStringExtra(EXTRA_TITLE);
    String bookId = getIntent().getStringExtra(EXTRA_BOOK);

    // Where this book was left last time. Saved on every page turn and on pause.
    reading = getSharedPreferences("shelfscout_reading", MODE_PRIVATE);
    positionKey = positionKey(bookId, url);

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.parseColor("#14120F"));

    LinearLayout bar = new LinearLayout(this);
    bar.setGravity(Gravity.CENTER_VERTICAL);
    bar.setPadding(dp(16), dp(10), dp(8), dp(10));

    TextView heading = new TextView(this);
    heading.setText(TextUtils.isEmpty(title) ? "PDF" : title);
    heading.setTextColor(Color.parseColor("#F2EBDF"));
    heading.setTextSize(16);
    heading.setMaxLines(1);
    heading.setEllipsize(TextUtils.TruncateAt.END);
    bar.addView(heading, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

    counter = new TextView(this);
    counter.setTextColor(Color.parseColor("#D9A15C"));
    counter.setTextSize(12);
    counter.setPadding(dp(8), dp(6), dp(8), dp(6));
    counter.setPaintFlags(counter.getPaintFlags() | Paint.UNDERLINE_TEXT_FLAG);
    counter.setText("Opening...");
    counter.setOnClickListener(v -> showJumpDialog());
    bar.addView(counter);

    Button close = new Button(this);
    close.setText("Close");
    close.setTextColor(Color.parseColor("#F2EBDF"));
    close.setBackgroundColor(Color.parseColor("#262119"));
    close.setOnClickListener(v -> finish());
    bar.addView(close);

    root.addView(bar);

    FrameLayout area = new FrameLayout(this);
    area.setBackgroundColor(Color.parseColor("#0C0A08"));
    image = new ImageView(this);
    image.setAdjustViewBounds(true);
    image.setScaleType(ImageView.ScaleType.FIT_CENTER);
    area.addView(image, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    root.addView(area, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

    LinearLayout foot = new LinearLayout(this);
    foot.setGravity(Gravity.CENTER);
    foot.setPadding(dp(12), dp(8), dp(12), dp(12));

    prev = new Button(this);
    prev.setText("Previous");
    prev.setTextColor(Color.parseColor("#F2EBDF"));
    prev.setBackgroundColor(Color.parseColor("#262119"));
    prev.setOnClickListener(v -> showPage(pageIndex - 1));

    next = new Button(this);
    next.setText("Next");
    next.setTextColor(Color.parseColor("#2A1D0E"));
    next.setBackgroundColor(Color.parseColor("#D9A15C"));
    next.setOnClickListener(v -> showPage(pageIndex + 1));

    foot.addView(prev);
    foot.addView(next);
    root.addView(foot);

    setContentView(root);

    area.setOnTouchListener(new View.OnTouchListener() {
      private float downX;

      @Override
      public boolean onTouch(View view, MotionEvent event) {
        if (event.getAction() == MotionEvent.ACTION_DOWN) {
          downX = event.getX();
          return true;
        }
        if (event.getAction() == MotionEvent.ACTION_UP) {
          float dx = event.getX() - downX;
          if (dx < -dp(50)) showPage(pageIndex + 1);
          else if (dx > dp(50)) showPage(pageIndex - 1);
          view.performClick();
          return true;
        }
        return true;
      }
    });

    counter.setText("Opening...");
    load(url, bookId);
  }

  private void load(final String url, final String bookId) {
    new Thread(() -> {
      File target = cacheFile(this, bookId, url);
      boolean ok = target.isFile() && target.length() > 0;
      if (!ok) ok = download(url, target);
      if (!ok) {
        runOnUiThread(() -> fail("Could not download this PDF. Check your internet."));
        return;
      }
      try {
        descriptor = ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY);
        renderer = new PdfRenderer(descriptor);
      } catch (Exception e) {
        closeRenderer();
        runOnUiThread(() -> fail("This file is not a readable PDF."));
        return;
      }
      runOnUiThread(() -> {
        int count = renderer.getPageCount();
        if (count == 0) {
          fail("This PDF has no pages.");
          return;
        }
        reading.edit().putInt(positionKey + "_pages", count).apply();
        int saved = reading.getInt(positionKey, 0);
        showPage(Math.max(0, Math.min(saved, count - 1)));
      });
    }).start();
  }

  private boolean download(String url, File target) {
    if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return false;
    File tmp = new File(target.getPath() + ".part");
    HttpURLConnection conn = null;
    InputStream in = null;
    FileOutputStream out = null;
    try {
      conn = (HttpURLConnection) new URL(url).openConnection();
      conn.setInstanceFollowRedirects(true);
      conn.setConnectTimeout(15000);
      conn.setReadTimeout(45000);
      conn.setRequestProperty("User-Agent", "ShelfScout");
      if (conn.getResponseCode() != 200) return false;
      File dir = target.getParentFile();
      if (dir != null) dir.mkdirs();
      in = conn.getInputStream();
      out = new FileOutputStream(tmp);
      byte[] buf = new byte[8192];
      int n;
      long total = 0;
      while ((n = in.read(buf)) > 0) {
        total += n;
        if (total > 80L * 1024 * 1024) return false;
        out.write(buf, 0, n);
      }
      out.close();
      out = null;
      in.close();
      in = null;
      return tmp.renameTo(target);
    } catch (Exception e) {
      return false;
    } finally {
      try { if (out != null) out.close(); } catch (Exception ignored) { /* already closed */ }
      try { if (in != null) in.close(); } catch (Exception ignored) { /* already closed */ }
      if (conn != null) conn.disconnect();
      if (tmp.exists()) tmp.delete();
    }
  }

  private void showPage(int index) {
    if (renderer == null) return;
    int count = renderer.getPageCount();
    if (count == 0 || index < 0 || index >= count) return;

    PdfRenderer.Page page = null;
    try {
      page = renderer.openPage(index);
      int width = getResources().getDisplayMetrics().widthPixels;
      float scale = Math.min(2f, (float) width / Math.max(1, page.getWidth()));
      int w = Math.max(1, Math.round(page.getWidth() * scale));
      int h = Math.max(1, Math.round(page.getHeight() * scale));

      Bitmap nextBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
      nextBitmap.eraseColor(Color.WHITE);
      page.render(nextBitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);

      if (pageBitmap != null) pageBitmap.recycle();
      pageBitmap = nextBitmap;
      image.setImageBitmap(pageBitmap);
      pageIndex = index;
    } catch (Exception e) {
      counter.setText("Could not draw this page.");
      return;
    } finally {
      if (page != null) page.close();
    }

    reading.edit().putInt(positionKey, index).apply();
    counter.setText((index + 1) + " / " + count);
    counter.setContentDescription("Page " + (index + 1) + " of " + count + ". Tap to jump to a page.");
    prev.setEnabled(index > 0);
    next.setEnabled(index < count - 1);
  }

  /** The page counter is a button: tap it and type a page to jump there. */
  private void showJumpDialog() {
    if (renderer == null) return;
    final int total = renderer.getPageCount();
    if (total <= 0) return;

    final EditText input = new EditText(this);
    input.setInputType(InputType.TYPE_CLASS_NUMBER);
    input.setText(String.valueOf(pageIndex + 1));
    input.setSelectAllOnFocus(true);
    input.setHint("1 - " + total);

    FrameLayout holder = new FrameLayout(this);
    holder.setPadding(dp(20), dp(4), dp(20), 0);
    holder.addView(input, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    new AlertDialog.Builder(this)
        .setTitle("Go to page")
        .setView(holder)
        .setPositiveButton("Go", (dialog, which) -> {
          try {
            int wanted = Integer.parseInt(input.getText().toString().trim());
            if (wanted < 1 || wanted > total) {
              Toast.makeText(this, "Enter a page between 1 and " + total + ".", Toast.LENGTH_SHORT).show();
              return;
            }
            showPage(wanted - 1);
          } catch (NumberFormatException e) {
            Toast.makeText(this, "Enter a page number.", Toast.LENGTH_SHORT).show();
          }
        })
        .setNegativeButton("Cancel", null)
        .show();
  }

  private void fail(String message) {
    counter.setText(message);
    prev.setEnabled(false);
    next.setEnabled(false);
  }

  private void closeRenderer() {
    try { if (renderer != null) renderer.close(); } catch (Exception ignored) { /* already closed */ }
    renderer = null;
    try { if (descriptor != null) descriptor.close(); } catch (Exception ignored) { /* already closed */ }
    descriptor = null;
  }

  @Override
  protected void onPause() {
    if (reading != null && !positionKey.isEmpty() && renderer != null) {
      reading.edit().putInt(positionKey, pageIndex).apply();
    }
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    closeRenderer();
    if (pageBitmap != null) {
      pageBitmap.recycle();
      pageBitmap = null;
    }
    super.onDestroy();
  }

  /* ---------------- cache ---------------- */

  private static File cacheDir(Context context) {
    File dir = new File(context.getCacheDir(), "pdfs");
    if (!dir.exists()) dir.mkdirs();
    return dir;
  }

  private static String safe(String value) {
    String id = String.valueOf(value == null ? "" : value).replaceAll("[^A-Za-z0-9_-]", "");
    return id.isEmpty() ? "book" : id;
  }

  private static String positionKey(String bookId, String url) {
    int hash = url == null ? 0 : url.hashCode();
    return "page_" + safe(bookId) + "-" + Integer.toHexString(hash);
  }

  static File cacheFile(Context context, String bookId, String url) {
    int hash = url == null ? 0 : url.hashCode();
    return new File(cacheDir(context), safe(bookId) + "-" + Integer.toHexString(hash) + ".pdf");
  }

  /**
   * Last page saved for this book, so the book screen can show progress and
   * offer Continue reading. Returns an empty string when it was never opened.
   */
  public static String readProgress(Context context, String bookId, String url) {
    SharedPreferences prefs = context.getSharedPreferences("shelfscout_reading", Context.MODE_PRIVATE);
    String key = positionKey(bookId, url);
    if (!prefs.contains(key)) return "";
    int page = prefs.getInt(key, 0);
    int pages = prefs.getInt(key + "_pages", 0);
    if (pages > 0 && page >= pages) page = pages - 1;
    return "{\"page\":" + (page + 1) + ",\"pages\":" + Math.max(0, pages) + "}";
  }

  /** Removes the cached PDF and the saved page for one book that was deleted. */
  public static void deleteCache(Context context, String bookId) {
    File[] files = cacheDir(context).listFiles();
    if (files != null) {
      String prefix = safe(bookId) + "-";
      for (File file : files) {
        if (file.getName().startsWith(prefix)) file.delete();
      }
    }

    SharedPreferences prefs = context.getSharedPreferences("shelfscout_reading", Context.MODE_PRIVATE);
    String pagePrefix = "page_" + safe(bookId) + "-";
    SharedPreferences.Editor editor = prefs.edit();
    boolean changed = false;
    for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
      if (entry.getKey().startsWith(pagePrefix)) {
        editor.remove(entry.getKey());
        changed = true;
      }
    }
    if (changed) editor.apply();
  }

  private int dp(int value) {
    return Math.round(getResources().getDisplayMetrics().density * value);
  }
}
