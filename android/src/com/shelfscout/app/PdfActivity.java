package com.shelfscout.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.pdf.PdfRenderer;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

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
  public static final String EXTRA_LISTEN = "listen";
  private static final int NOTIFY_PERMISSION = 12;

  private PdfRenderer renderer;
  private ParcelFileDescriptor descriptor;
  private ImageView image;
  private TextView counter;
  private Button prev;
  private Button next;
  private Button listen;
  private int pageIndex = 0;
  private Bitmap pageBitmap;
  private SharedPreferences reading;
  private SharedPreferences audioPrefs;
  private String positionKey = "";
  private String bookId = "";
  private String url = "";
  private String title = "";
  private boolean listenPending = false;

  private final AudioPlaybackService.Listener audioListener = new AudioPlaybackService.Listener() {
    @Override
    public void onProgress(int page, int total, String state) {
      runOnUiThread(() -> {
        if (listen != null) {
          if ("playing".equals(state)) listen.setText("Listening");
          else if ("paused".equals(state)) listen.setText("Paused");
          else if ("preparing".equals(state)) listen.setText("Preparing...");
          else listen.setText("Listen");
        }
        if (page > 0 && ("playing".equals(state) || "paused".equals(state)) && page - 1 != pageIndex) {
          showPage(page - 1);
        }
      });
    }

    @Override
    public void onError(String message) {
      runOnUiThread(() -> {
        if (listen != null) listen.setText("Listen");
        Toast.makeText(PdfActivity.this, message, Toast.LENGTH_LONG).show();
      });
    }
  };

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);

    url = value(getIntent().getStringExtra(EXTRA_URL));
    title = value(getIntent().getStringExtra(EXTRA_TITLE));
    bookId = value(getIntent().getStringExtra(EXTRA_BOOK));
    listenPending = getIntent().getBooleanExtra(EXTRA_LISTEN, false);

    // Where this book was left last time. Saved on every page turn and on pause.
    reading = getSharedPreferences("shelfscout_reading", MODE_PRIVATE);
    audioPrefs = getSharedPreferences("shelfscout_audio", MODE_PRIVATE);
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
    prev.setText("Prev");
    prev.setTextColor(Color.parseColor("#F2EBDF"));
    prev.setBackgroundColor(Color.parseColor("#262119"));
    prev.setOnClickListener(v -> showPage(pageIndex - 1));

    listen = new Button(this);
    listen.setText("Listen");
    listen.setTextColor(Color.parseColor("#DCE8D8"));
    listen.setBackgroundColor(Color.parseColor("#2B3A2C"));
    listen.setOnClickListener(v -> showListenDialog());

    next = new Button(this);
    next.setText("Next");
    next.setTextColor(Color.parseColor("#2A1D0E"));
    next.setBackgroundColor(Color.parseColor("#D9A15C"));
    next.setOnClickListener(v -> showPage(pageIndex + 1));

    foot.addView(prev);
    foot.addView(listen);
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
        if (listenPending) {
          listenPending = false;
          showListenDialog();
        }
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

  /** Opens the voice and style picker for the free offline voice. */
  private void showListenDialog() {
    if (renderer == null) {
      Toast.makeText(this, "The PDF is still opening.", Toast.LENGTH_SHORT).show();
      return;
    }
    if (AudioPlaybackService.isActiveFor(bookId)) {
      showActiveDialog();
      return;
    }

    final ProgressDialog progress = ProgressDialog.show(
        this, "Read aloud", "Checking the offline voices on this phone...", true, false);
    final TextToSpeech[] picker = new TextToSpeech[1];
    picker[0] = new TextToSpeech(this, status -> runOnUiThread(() -> {
      progress.dismiss();
      if (status != TextToSpeech.SUCCESS) {
        showVoiceError("Text to speech is not available on this phone.");
        return;
      }
      picker[0].setLanguage(Locale.ENGLISH);
      List<Voice> voices = new ArrayList<>();
      String defaultName = "";
      try {
        Voice defaultVoice = picker[0].getDefaultVoice();
        if (defaultVoice != null) defaultName = defaultVoice.getName();
        Set<Voice> all = picker[0].getVoices();
        if (all != null) {
          for (Voice voice : all) {
            if (voice.getLocale() == null || !"en".equals(voice.getLocale().getLanguage())) continue;
            if (voice.isNetworkConnectionRequired()) continue;
            voices.add(voice);
          }
        }
      } catch (Exception ignored) {
        /* the engine may not expose its voices */
      }
      try { picker[0].shutdown(); } catch (Exception ignored) { /* already gone */ }
      if (voices.isEmpty()) {
        showVoiceError("No English offline voice is installed. Open the voice settings and download one.");
        return;
      }
      showVoiceDialog(voices, defaultName);
    }));
  }

  private void showActiveDialog() {
    int page = reading.getInt(positionKey, pageIndex) + 1;
    String state = AudioPlaybackService.stateFor(bookId);
    String label = "preparing".equals(state) ? "preparing the text"
        : ("paused".equals(state) ? "paused" : "playing");
    new AlertDialog.Builder(this)
        .setTitle("Reading aloud")
        .setMessage("The offline voice is " + label + " on page " + page + ".")
        .setPositiveButton("Stop", (dialog, which) -> stopListening())
        .setNegativeButton("Close", null)
        .show();
  }

  private void showVoiceDialog(List<Voice> voices, String defaultName) {
    final String[] voiceLabels = new String[voices.size()];
    int voiceIndex = 0;
    String savedVoice = audioPrefs.getString("voice", "");
    for (int i = 0; i < voices.size(); i++) {
      Voice voice = voices.get(i);
      voiceLabels[i] = voiceLabel(voice);
      if (!savedVoice.isEmpty() && savedVoice.equals(voice.getName())) voiceIndex = i;
      else if (savedVoice.isEmpty() && voiceIndex == 0 && defaultName.equals(voice.getName())) voiceIndex = i;
    }

    final String[] styleLabels = new String[5];
    for (int i = 0; i < 5; i++) styleLabels[i] = AudioText.styleName(i);
    final float[] speeds = {0.8f, 0.9f, 1.0f, 1.1f, 1.2f};
    final String[] speedLabels = {"0.8x", "0.9x", "1.0x", "1.1x", "1.2x"};

    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setPadding(dp(20), dp(4), dp(20), 0);

    TextView note = new TextView(this);
    note.setText("Only offline English voices installed on this phone are listed. Male and female labels appear when the voice name includes one. Styles change pace and pitch; the free voice cannot act emotions like a paid cloud voice. This works for PDFs that contain text, not image-only scans.");
    note.setTextColor(Color.parseColor("#A99C88"));
    note.setTextSize(12);
    note.setPadding(0, 0, 0, dp(10));
    box.addView(note);

    box.addView(label("Voice"));
    Spinner voiceSpinner = spinner(voiceLabels, voiceIndex);
    box.addView(voiceSpinner);

    box.addView(label("Style"));
    Spinner styleSpinner = spinner(styleLabels, Math.max(0, Math.min(4, audioPrefs.getInt("style", 0))));
    box.addView(styleSpinner);

    box.addView(label("Speed"));
    Spinner speedSpinner = spinner(speedLabels, Math.max(0, Math.min(4, audioPrefs.getInt("speed", 2))));
    box.addView(speedSpinner);

    new AlertDialog.Builder(this)
        .setTitle("Read aloud")
        .setView(box)
        .setPositiveButton("Start", (dialog, which) -> {
          int vi = voiceSpinner.getSelectedItemPosition();
          int si = styleSpinner.getSelectedItemPosition();
          int spi = speedSpinner.getSelectedItemPosition();
          Voice voice = voices.get(Math.max(0, Math.min(vi, voices.size() - 1)));
          audioPrefs.edit()
              .putString("voice", voice.getName())
              .putInt("style", si)
              .putInt("speed", spi)
              .apply();
          startListening(voice, si, speeds[spi]);
        })
        .setNegativeButton("Cancel", null)
        .setNeutralButton("Voice settings", (dialog, which) -> openVoiceSettings())
        .show();
  }

  private TextView label(String text) {
    TextView view = new TextView(this);
    view.setText(text);
    view.setTextColor(Color.parseColor("#A99C88"));
    view.setTextSize(11);
    view.setPadding(0, dp(12), 0, dp(4));
    return view;
  }

  private Spinner spinner(String[] values, int selected) {
    Spinner spinner = new Spinner(this);
    ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, values);
    adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
    spinner.setAdapter(adapter);
    spinner.setSelection(Math.max(0, Math.min(selected, values.length - 1)));
    return spinner;
  }

  private String voiceLabel(Voice voice) {
    String name = voice.getName();
    String lower = name.toLowerCase(Locale.ROOT);
    if (lower.contains("female")) return "Female - " + name;
    if (lower.contains("male")) return "Male - " + name;
    return name;
  }

  private void startListening(Voice voice, int style, float speed) {
    if (renderer == null) return;
    File file = cacheFile(this, bookId, url);
    if (!file.isFile()) {
      Toast.makeText(this, "The PDF is still downloading.", Toast.LENGTH_SHORT).show();
      return;
    }

    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY_PERMISSION);
    }

    Intent intent = new Intent(this, AudioPlaybackService.class)
        .setAction(AudioPlaybackService.ACTION_START)
        .putExtra(AudioPlaybackService.EXTRA_FILE, file.getAbsolutePath())
        .putExtra(AudioPlaybackService.EXTRA_URL, url)
        .putExtra(AudioPlaybackService.EXTRA_BOOK, bookId)
        .putExtra(AudioPlaybackService.EXTRA_TITLE, title)
        .putExtra(AudioPlaybackService.EXTRA_POSITION_KEY, positionKey)
        .putExtra(AudioPlaybackService.EXTRA_START_PAGE, pageIndex + 1)
        .putExtra(AudioPlaybackService.EXTRA_TOTAL_PAGES, renderer.getPageCount())
        .putExtra(AudioPlaybackService.EXTRA_VOICE, voice.getName())
        .putExtra(AudioPlaybackService.EXTRA_STYLE, style)
        .putExtra(AudioPlaybackService.EXTRA_SPEED, speed);
    if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
    else startService(intent);
    listen.setText("Preparing...");
    Toast.makeText(this, "Preparing the text. Playback starts in a moment.", Toast.LENGTH_SHORT).show();
  }

  private void stopListening() {
    Intent intent = new Intent(this, AudioPlaybackService.class);
    intent.setAction(AudioPlaybackService.ACTION_STOP);
    startService(intent);
    if (listen != null) listen.setText("Listen");
  }

  private void showVoiceError(String message) {
    new AlertDialog.Builder(this)
        .setTitle("Read aloud")
        .setMessage(message)
        .setPositiveButton("Voice settings", (dialog, which) -> openVoiceSettings())
        .setNegativeButton("Close", null)
        .show();
  }

  private void openVoiceSettings() {
    try {
      startActivity(new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA));
    } catch (Exception first) {
      try {
        startActivity(new Intent("com.android.settings.TTS_SETTINGS"));
      } catch (Exception second) {
        Toast.makeText(this, "Open Android Settings, then Text-to-speech output.", Toast.LENGTH_LONG).show();
      }
    }
  }

  private String value(String text) {
    return text == null ? "" : text;
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
  protected void onResume() {
    super.onResume();
    AudioPlaybackService.setListener(audioListener);
    if (listen != null && AudioPlaybackService.isActiveFor(bookId)) {
      String state = AudioPlaybackService.stateFor(bookId);
      listen.setText("playing".equals(state) ? "Listening"
          : ("preparing".equals(state) ? "Preparing..." : "Paused"));
      int saved = reading.getInt(positionKey, pageIndex);
      if (saved != pageIndex) showPage(saved);
    }
  }

  @Override
  protected void onPause() {
    AudioPlaybackService.setListener(null);
    if (reading != null && !positionKey.isEmpty() && renderer != null) {
      reading.edit().putInt(positionKey, pageIndex).apply();
    }
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    AudioPlaybackService.setListener(null);
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
