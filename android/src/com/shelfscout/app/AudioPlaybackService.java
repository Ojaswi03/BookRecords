package com.shelfscout.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.text.PDFTextStripper;
import com.tom_roush.pdfbox.text.TextPosition;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Reads a book with the phone's offline text-to-speech engine.
 *
 * The PDF text is extracted once per playback, split into sentence-sized
 * chunks, and spoken in order. The last chunk and page are saved so the reader
 * resumes where it stopped. All of this runs on the phone; no server or API key
 * is involved.
 */
public class AudioPlaybackService extends Service {
  public static final String ACTION_START = "com.shelfscout.app.AUDIO_START";
  public static final String ACTION_STOP = "com.shelfscout.app.AUDIO_STOP";
  public static final String ACTION_PAUSE = "com.shelfscout.app.AUDIO_PAUSE";
  public static final String ACTION_RESUME = "com.shelfscout.app.AUDIO_RESUME";
  public static final String ACTION_NEXT = "com.shelfscout.app.AUDIO_NEXT";
  public static final String ACTION_PREVIOUS = "com.shelfscout.app.AUDIO_PREVIOUS";
  public static final String ACTION_SEEK_PAGE = "com.shelfscout.app.AUDIO_SEEK_PAGE";
  public static final String ACTION_SYNC = "com.shelfscout.app.AUDIO_SYNC";

  public static final String EXTRA_FILE = "file";
  public static final String EXTRA_URL = "url";
  public static final String EXTRA_BOOK = "book";
  public static final String EXTRA_TITLE = "title";
  public static final String EXTRA_POSITION_KEY = "position_key";
  public static final String EXTRA_START_PAGE = "start_page";
  public static final String EXTRA_TOTAL_PAGES = "total_pages";
  public static final String EXTRA_VOICE = "voice";
  public static final String EXTRA_STYLE = "style";
  public static final String EXTRA_SPEED = "speed";
  public static final String EXTRA_SEEK_PAGE = "seek_page";

  private static final String CHANNEL = "shelfscout_audio";
  private static final String PREFS = "shelfscout_audio";
  private static final int NOTIFY_ID = 7312;

  public interface Listener {
    void onProgress(int page, int totalPages, String state);
    void onError(String message);

    /** The lines the voice is reading now, in page points from the top left. */
    void onHighlight(int page, float[] boxes, float pageWidth, float pageHeight, String text);
  }

  private static Listener listener;
  private static String activeBook = "";
  private static String activeState = "idle";
  private static int activePage;

  private TextToSpeech tts;
  private boolean ttsReady;
  private boolean ttsStarting;
  private boolean ttsListenerSet;
  private boolean prepared;
  private boolean preparing;
  private boolean playing;
  private boolean paused;
  private int generation;
  private int index;
  private int startPage = 1;
  private int totalPages;
  private int style;
  private float speed = 1f;
  private String bookId = "";
  private String title = "";
  private String url = "";
  private String positionKey = "";
  private String filePath = "";
  private String voiceName = "";
  private String utteranceId = "";
  private final List<AudioText.Chunk> chunks = new ArrayList<>();
  private final List<Integer> pages = new ArrayList<>();
  private final List<float[]> pageSizes = new ArrayList<>();
  private SharedPreferences prefs;
  private final Handler main = new Handler(Looper.getMainLooper());
  private AudioManager audio;
  private boolean focusHeld;
  private PowerManager.WakeLock wake;
  private MediaSession session;
  private BroadcastReceiver noisy;
  private boolean noisyRegistered;

  private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      if (playing) pause();
    }
  };

  public static void setListener(Listener value) {
    listener = value;
  }

  public static boolean isActiveFor(String id) {
    return id != null && id.equals(activeBook)
        && !"idle".equals(activeState)
        && !"stopped".equals(activeState)
        && !"finished".equals(activeState)
        && !"error".equals(activeState);
  }

  public static String stateFor(String id) {
    return isActiveFor(id) ? activeState : "";
  }

  public static int pageFor(String id) {
    return isActiveFor(id) ? activePage : 0;
  }

  /** Stops the voice and clears the cached state, so Listen works at once. */
  public static void stopNow(Context context) {
    send(context, ACTION_STOP);
    activeBook = "";
    activeState = "stopped";
    activePage = 0;
  }

  /** Re-sends the current page and line, used when the reader comes back. */
  public static void syncNow(Context context) {
    send(context, ACTION_SYNC);
  }

  /** Sends play, pause or stop from the reader screen. */
  public static void pauseFor(Context context) {
    send(context, ACTION_PAUSE);
  }

  public static void resumeFor(Context context) {
    send(context, ACTION_RESUME);
  }

  /** Moves the voice to the first sentence of a page the reader turned to. */
  public static void seekPage(Context context, int page) {
    if (context == null || page < 1) return;
    if (!"playing".equals(activeState) && !"paused".equals(activeState)
        && !"preparing".equals(activeState)) {
      return;
    }
    try {
      context.startService(new Intent(context, AudioPlaybackService.class)
          .setAction(ACTION_SEEK_PAGE)
          .putExtra(EXTRA_SEEK_PAGE, page));
    } catch (Exception ignored) {
      /* the service is not running */
    }
  }

  private static void send(Context context, String action) {
    if (context == null) return;
    try {
      context.startService(new Intent(context, AudioPlaybackService.class).setAction(action));
    } catch (Exception ignored) {
      /* the service is not running */
    }
  }

  /** Stops playback when the book is deleted. */
  public static void stopForBook(Context context, String id) {
    if (!isActiveFor(id)) return;
    try {
      context.stopService(new Intent(context, AudioPlaybackService.class));
    } catch (Exception ignored) {
      /* the activity is already gone */
    }
  }

  @Override
  public void onCreate() {
    super.onCreate();
    prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    audio = (AudioManager) getSystemService(AUDIO_SERVICE);
    PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
    wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ShelfScout:Audio");
    wake.setReferenceCounted(false);
    createChannel();
    createSession();
    registerNoisy();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent == null) {
      stopSelf();
      return START_NOT_STICKY;
    }
    String action = intent.getAction();
    if (ACTION_STOP.equals(action)) {
      stopPlayback();
      return START_NOT_STICKY;
    }
    if (ACTION_PAUSE.equals(action)) {
      pause();
      return START_NOT_STICKY;
    }
    if (ACTION_RESUME.equals(action)) {
      resume();
      return START_NOT_STICKY;
    }
    if (ACTION_NEXT.equals(action)) {
      next();
      return START_NOT_STICKY;
    }
    if (ACTION_PREVIOUS.equals(action)) {
      previous();
      return START_NOT_STICKY;
    }
    if (ACTION_SEEK_PAGE.equals(action)) {
      seekToPage(intent.getIntExtra(EXTRA_SEEK_PAGE, 0));
      return START_NOT_STICKY;
    }
    if (ACTION_SYNC.equals(action)) {
      if (prepared) {
        notifyListener();
        notifyHighlight();
      }
      return START_NOT_STICKY;
    }
    if (ACTION_START.equals(action)) {
      begin(intent);
    }
    return START_NOT_STICKY;
  }

  private void begin(Intent intent) {
    stopInternal();
    bookId = value(intent.getStringExtra(EXTRA_BOOK));
    title = value(intent.getStringExtra(EXTRA_TITLE));
    url = value(intent.getStringExtra(EXTRA_URL));
    positionKey = value(intent.getStringExtra(EXTRA_POSITION_KEY));
    filePath = value(intent.getStringExtra(EXTRA_FILE));
    voiceName = value(intent.getStringExtra(EXTRA_VOICE));
    startPage = Math.max(1, intent.getIntExtra(EXTRA_START_PAGE, 1));
    totalPages = Math.max(0, intent.getIntExtra(EXTRA_TOTAL_PAGES, 0));
    style = Math.max(0, Math.min(4, intent.getIntExtra(EXTRA_STYLE, 0)));
    speed = intent.getFloatExtra(EXTRA_SPEED, 1f);
    if (speed < 0.5f || speed > 2f) speed = 1f;

    generation++;
    activeBook = bookId;
    activeState = "preparing";
    activePage = startPage;
    preparing = true;
    prepared = false;
    playing = false;
    paused = false;
    index = 0;

    startForeground(NOTIFY_ID, buildNotification("Preparing the text...", false));

    if (filePath.isEmpty() || !new File(filePath).isFile()) {
      fail("The PDF file is no longer on this phone.");
      return;
    }

    initTts();
    final int gen = generation;
    new Thread(() -> extract(gen), "shelfscout-pdf-text").start();
    notifyListener();
    updateSession();
  }

  private void initTts() {
    if (tts != null) {
      if (ttsReady) configureVoice();
      return;
    }
    if (ttsStarting) return;
    ttsStarting = true;
    tts = new TextToSpeech(this, status -> main.post(() -> {
      ttsStarting = false;
      if (status != TextToSpeech.SUCCESS) {
        fail("Text to speech is not available on this phone.");
        return;
      }
      ttsReady = true;
      tts.setAudioAttributes(new AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build());
      if (!configureVoice()) return;
      if (prepared && playing) speak();
    }));
  }

  private boolean configureVoice() {
    if (tts == null) return false;
    Voice chosen = null;
    Voice fallback = null;
    try {
      Set<Voice> voices = tts.getVoices();
      if (voices != null) {
        for (Voice voice : voices) {
          if (!"en".equals(voice.getLocale().getLanguage())) continue;
          if (voice.isNetworkConnectionRequired()) continue;
          if (fallback == null) fallback = voice;
          if (!voiceName.isEmpty() && voiceName.equals(voice.getName())) {
            chosen = voice;
            break;
          }
        }
      }
    } catch (Exception ignored) {
      /* some engines do not expose a voice list */
    }

    if (chosen == null) chosen = fallback;
    if (chosen != null) {
      int result = tts.setVoice(chosen);
      if (result == TextToSpeech.ERROR) {
        fail("The selected offline voice is not available.");
        return false;
      }
    } else {
      int language = tts.setLanguage(Locale.ENGLISH);
      if (language == TextToSpeech.LANG_MISSING_DATA || language == TextToSpeech.LANG_NOT_SUPPORTED) {
        fail("Install an English offline voice in Android text-to-speech settings.");
        return false;
      }
    }

    tts.setSpeechRate(AudioText.styleRate(style) * speed);
    tts.setPitch(AudioText.stylePitch(style));
    if (!ttsListenerSet) {
      tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
        @Override
        public void onStart(String id) {
          main.post(() -> {
            if (id.equals(utteranceId)) {
              savePosition();
              updateForPage(true);
            }
          });
        }

        @Override
        public void onDone(String id) {
          main.post(() -> {
            if (!id.equals(utteranceId) || !playing) return;
            if (index + 1 < chunks.size()) {
              index++;
              speak();
            } else {
              finish();
            }
          });
        }

        @Override
        public void onError(String id) {
          main.post(() -> {
            if (id.equals(utteranceId)) fail("The offline voice could not read this section.");
          });
        }
      });
      ttsListenerSet = true;
    }
    return true;
  }

  private void extract(int gen) {
    List<List<AudioText.Line>> pageLines = new ArrayList<>();
    List<float[]> sizes = new ArrayList<>();
    PDDocument document = null;
    try {
      PDFBoxResourceLoader.init(getApplicationContext());
      MemoryUsageSetting memory = MemoryUsageSetting.setupMixed(16L * 1024 * 1024);
      memory.setTempDir(getCacheDir());
      document = PDDocument.load(new File(filePath), memory);
      int count = document.getNumberOfPages();
      if (count <= 0) {
        main.post(() -> {
          if (gen == generation) fail("This PDF has no pages.");
        });
        return;
      }
      for (int page = 1; page <= count; page++) {
        if (gen != generation) return;
        PositionStripper stripper = new PositionStripper();
        stripper.setSortByPosition(true);
        stripper.setStartPage(page);
        stripper.setEndPage(page);
        stripper.getText(document);
        pageLines.add(stripper.lines);
        sizes.add(pageSize(document.getPage(page - 1)));
        if (page % 15 == 0) {
          final int done = page;
          main.post(() -> {
            if (gen == generation) {
              updateNotification("Preparing text... page " + done + " of " + count, false);
            }
          });
        }
      }

      // Running heads, page numbers, then the title and copyright pages that
      // free PDFs put in front of the book itself.
      AudioText.stripRunningHeads(pageLines, sizes);
      List<String> pageText = new ArrayList<>();
      for (List<AudioText.Line> lines : pageLines) pageText.add(AudioText.join(lines));
      int skip = AudioText.frontMatterPages(pageText);

      List<AudioText.Chunk> foundChunks = new ArrayList<>();
      List<Integer> foundPages = new ArrayList<>();
      for (int page = skip; page < pageLines.size(); page++) {
        for (AudioText.Chunk chunk : AudioText.chunks(pageLines.get(page))) {
          foundChunks.add(chunk);
          foundPages.add(page + 1);
        }
      }

      final List<AudioText.Chunk> resultChunks = foundChunks;
      final List<Integer> resultPages = foundPages;
      final List<float[]> resultSizes = sizes;
      main.post(() -> {
        if (gen == generation) onPrepared(resultChunks, resultPages, resultSizes);
      });
    } catch (Exception | LinkageError e) {
      Log.w("ShelfScoutAudio", "PDF text extraction failed", e);
      main.post(() -> {
        if (gen == generation) fail("This PDF has no readable text layer. OCR is not included yet.");
      });
    } finally {
      try { if (document != null) document.close(); } catch (Exception ignored) { /* already closed */ }
    }
  }

  private static float[] pageSize(PDPage page) {
    float width = 595f;
    float height = 842f;
    try {
      if (page.getMediaBox() != null) {
        width = page.getMediaBox().getWidth();
        height = page.getMediaBox().getHeight();
      }
    } catch (Exception ignored) {
      /* malformed page box: keep A4 */
    }
    int rotation = (page.getRotation() + 360) % 360;
    if (rotation == 90 || rotation == 270) {
      float swap = width;
      width = height;
      height = swap;
    }
    if (width <= 0 || height <= 0) return new float[]{595f, 842f};
    return new float[]{width, height};
  }

  /** Keeps the box of every line so the reader can mark what is being spoken. */
  private static final class PositionStripper extends PDFTextStripper {
    final List<AudioText.Line> lines = new ArrayList<>();

    PositionStripper() throws IOException {
      super();
    }

    @Override
    protected void writeString(String text, List<TextPosition> positions) {
      String tidy = AudioText.tidy(text);
      if (tidy.isEmpty() || positions == null || positions.isEmpty()) return;

      float left = Float.MAX_VALUE;
      float top = Float.MAX_VALUE;
      float right = -Float.MAX_VALUE;
      float bottom = -Float.MAX_VALUE;
      for (TextPosition position : positions) {
        float height = position.getHeightDir();
        if (height <= 0) height = position.getFontSizeInPt() > 0 ? position.getFontSizeInPt() : 10f;
        float x = position.getXDirAdj();
        left = Math.min(left, x);
        right = Math.max(right, x + Math.max(position.getWidthDirAdj(), 0.5f));
        top = Math.min(top, position.getYDirAdj() - height * 0.85f);
        bottom = Math.max(bottom, position.getYDirAdj() + height * 0.20f);
      }
      if (right <= left || bottom <= top) return;
      lines.add(new AudioText.Line(tidy, left, top, right, bottom));
    }
  }

  private void onPrepared(List<AudioText.Chunk> foundChunks, List<Integer> foundPages,
                          List<float[]> foundSizes) {
    if (!preparing) return;
    if (foundChunks.isEmpty()) {
      fail("This PDF is image-only. OCR is not included yet.");
      return;
    }
    chunks.clear();
    chunks.addAll(foundChunks);
    pages.clear();
    pages.addAll(foundPages);
    pageSizes.clear();
    pageSizes.addAll(foundSizes);
    if (totalPages <= 0) totalPages = pages.get(pages.size() - 1);
    preparing = false;
    prepared = true;
    index = chooseStart();
    playing = true;
    paused = false;
    activeState = "playing";
    updateSession();
    if (ttsReady) {
      speak();
    } else {
      updateNotification("Preparing the offline voice...", false);
      notifyListener();
    }
  }

  private int chooseStart() {
    int saved = prefs.getInt(positionKey + "_audio", -1);
    if (saved >= 0 && saved < pages.size()) {
      int savedPage = pages.get(saved);
      if (Math.abs(savedPage - startPage) <= 1) return saved;
    }
    for (int i = 0; i < pages.size(); i++) {
      if (pages.get(i) >= startPage) return i;
    }
    return 0;
  }

  private void speak() {
    if (!playing || !prepared || !ttsReady || index < 0 || index >= chunks.size()) return;
    if (!requestFocus()) {
      fail("Another app is using the audio output.");
      return;
    }
    acquireWake();
    generation++;
    final int gen = generation;
    utteranceId = "chunk-" + index + "-" + gen;
    Bundle params = new Bundle();
    params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId);
    tts.setSpeechRate(AudioText.styleRate(style) * speed);
    tts.setPitch(AudioText.stylePitch(style));
    int result = tts.speak(chunks.get(index).text, TextToSpeech.QUEUE_FLUSH, params, utteranceId);
    if (result == TextToSpeech.ERROR) {
      fail("The offline voice could not start.");
      return;
    }
    activeState = "playing";
    updateForPage(true);
    notifyHighlight();
    updateSession();
  }

  /** Moves the voice to the first sentence of a page the reader turned to. */
  private void seekToPage(int page) {
    if (page < 1) return;
    startPage = page;
    if (!prepared) return;

    int target = pages.size() - 1;
    for (int i = 0; i < pages.size(); i++) {
      if (pages.get(i) >= page) {
        target = i;
        break;
      }
    }
    if (target == index && playing) return;

    generation++;
    if (tts != null) tts.stop();
    index = Math.max(0, target);
    savePosition();
    if (playing) {
      speak();
    } else {
      updateForPage(false);
      notifyHighlight();
    }
  }

  private void notifyHighlight() {
    if (listener == null || chunks.isEmpty()) return;
    int safeIndex = Math.max(0, Math.min(index, chunks.size() - 1));
    int page = currentPage();
    if (page <= 0) return;
    float[] size = page >= 1 && page <= pageSizes.size()
        ? pageSizes.get(page - 1)
        : new float[]{595f, 842f};
    AudioText.Chunk chunk = chunks.get(safeIndex);
    listener.onHighlight(page, AudioText.boxes(chunk), size[0], size[1], chunk.text);
  }

  private void pause() {
    if (preparing || !playing) return;
    playing = false;
    paused = true;
    generation++;
    if (tts != null) tts.stop();
    savePosition();
    releaseWake();
    abandonFocus();
    activeState = "paused";
    updateNotification("Paused - " + pageLabel(), false);
    updateSession();
    notifyListener();
  }

  private void resume() {
    if (!prepared || playing) return;
    paused = false;
    playing = true;
    activeState = "playing";
    speak();
  }

  private void next() {
    if (!prepared || preparing) return;
    generation++;
    if (tts != null) tts.stop();
    if (index + 1 < chunks.size()) index++;
    savePosition();
    if (playing) {
      speak();
    } else {
      updateForPage(false);
      notifyHighlight();
      updateSession();
    }
  }

  private void previous() {
    if (!prepared || preparing) return;
    generation++;
    if (tts != null) tts.stop();
    if (index > 0) index--;
    savePosition();
    if (playing) {
      speak();
    } else {
      updateForPage(false);
      notifyHighlight();
      updateSession();
    }
  }

  private void finish() {
    playing = false;
    paused = false;
    preparing = false;
    prepared = false;
    generation++;
    savePosition();
    releaseWake();
    abandonFocus();
    activeState = "finished";
    final int page = currentPage();
    notifyListener(page, activeState);
    updateNotification("Finished", false);
    updateSession();
    activeBook = "";
    final int gen = generation;
    main.postDelayed(() -> {
      if (gen != generation) return;
      stopForeground(true);
      stopSelf();
    }, 1200);
  }

  private void stopPlayback() {
    savePosition();
    final int page = currentPage();
    playing = false;
    paused = false;
    preparing = false;
    prepared = false;
    generation++;
    if (tts != null) tts.stop();
    releaseWake();
    abandonFocus();
    activeState = "stopped";
    notifyListener(page, activeState);
    updateSession();
    activeBook = "";
    activePage = 0;
    stopForeground(true);
    stopSelf();
  }

  private void stopInternal() {
    generation++;
    if (tts != null) tts.stop();
    playing = false;
    paused = false;
    preparing = false;
    prepared = false;
    index = 0;
    chunks.clear();
    pages.clear();
    pageSizes.clear();
    releaseWake();
    abandonFocus();
  }

  private void fail(String message) {
    playing = false;
    paused = false;
    preparing = false;
    prepared = false;
    generation++;
    if (tts != null) tts.stop();
    releaseWake();
    abandonFocus();
    activeState = "error";
    activeBook = "";
    if (listener != null) listener.onError(message);
    try {
      updateNotification(message, false);
    } catch (Exception ignored) {
      /* the notification service is going away */
    }
    final int gen = generation;
    main.postDelayed(() -> {
      if (gen != generation) return;
      stopForeground(true);
      stopSelf();
    }, 6000);
  }

  private void savePosition() {
    if (positionKey.isEmpty() || pages.isEmpty()) return;
    int safeIndex = Math.max(0, Math.min(index, pages.size() - 1));
    prefs.edit()
        .putInt(positionKey, Math.max(0, pages.get(safeIndex) - 1))
        .putInt(positionKey + "_audio", safeIndex)
        .apply();
  }

  private int currentPage() {
    if (pages.isEmpty()) return 0;
    int safeIndex = Math.max(0, Math.min(index, pages.size() - 1));
    return pages.get(safeIndex);
  }

  private String pageLabel() {
    int page = currentPage();
    if (page <= 0) return "page 1";
    return totalPages > 0 ? "page " + page + " of " + totalPages : "page " + page;
  }

  private void updateForPage(boolean save) {
    if (save) savePosition();
    updateNotification((playing ? "Listening - " : "Paused - ") + pageLabel(), playing);
    notifyListener();
  }

  private void notifyListener() {
    notifyListener(currentPage(), activeState);
  }

  private void notifyListener(int page, String state) {
    activePage = page;
    if (listener != null) listener.onProgress(page, totalPages, state);
  }

  private boolean requestFocus() {
    if (audio == null) return true;
    if (focusHeld) return true;
    int result = audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
    focusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    return focusHeld;
  }

  private void abandonFocus() {
    if (audio == null || !focusHeld) return;
    audio.abandonAudioFocus(focusListener);
    focusHeld = false;
  }

  private void acquireWake() {
    try {
      if (wake != null && !wake.isHeld()) wake.acquire(30 * 60 * 1000L);
    } catch (Exception ignored) {
      /* battery optimisation can refuse the lock */
    }
  }

  private void releaseWake() {
    try {
      if (wake != null && wake.isHeld()) wake.release();
    } catch (Exception ignored) {
      /* already released */
    }
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    NotificationChannel channel = new NotificationChannel(
        CHANNEL, "Offline reading aloud", NotificationManager.IMPORTANCE_LOW);
    channel.setDescription("Playback controls for the offline voice");
    channel.setShowBadge(false);
    manager.createNotificationChannel(channel);
  }

  private void createSession() {
    session = new MediaSession(this, "ShelfScoutAudio");
    session.setCallback(new MediaSession.Callback() {
      @Override public void onPlay() { resume(); }
      @Override public void onPause() { pause(); }
      @Override public void onStop() { stopPlayback(); }
      @Override public void onSkipToNext() { next(); }
      @Override public void onSkipToPrevious() { previous(); }
    });
    session.setActive(true);
  }

  private Notification buildNotification(String status, boolean isPlaying) {
    Intent open = new Intent(this, PdfActivity.class)
        .putExtra(PdfActivity.EXTRA_URL, url)
        .putExtra(PdfActivity.EXTRA_BOOK, bookId)
        .putExtra(PdfActivity.EXTRA_TITLE, title);
    PendingIntent content = PendingIntent.getActivity(
        this, 0, open,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Notification.Builder builder = Build.VERSION.SDK_INT >= 26
        ? new Notification.Builder(this, CHANNEL)
        : new Notification.Builder(this);
    builder.setSmallIcon(android.R.drawable.ic_media_play)
        .setContentTitle(title.isEmpty() ? "ShelfScout" : title)
        .setContentText(status)
        .setContentIntent(content)
        .setShowWhen(false)
        .setOnlyAlertOnce(true)
        .setOngoing(isPlaying || paused || preparing)
        .setVisibility(Notification.VISIBILITY_PUBLIC);

    if (prepared || paused) {
      builder.addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREVIOUS, 1));
      builder.addAction(action(
          isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
          isPlaying ? "Pause" : "Play",
          isPlaying ? ACTION_PAUSE : ACTION_RESUME, 2));
      builder.addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT, 3));
    }
    builder.addAction(action(android.R.drawable.ic_menu_close_clear_cancel, "Stop", ACTION_STOP, 4));

    if (session != null && (prepared || paused)) {
      builder.setStyle(new Notification.MediaStyle()
          .setMediaSession(session.getSessionToken())
          .setShowActionsInCompactView(0, 1, 2));
    }
    return builder.build();
  }

  private Notification.Action action(int icon, String label, String action, int code) {
    Intent intent = new Intent(this, AudioPlaybackService.class).setAction(action);
    PendingIntent pending = PendingIntent.getService(
        this, code, intent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Action.Builder(Icon.createWithResource(this, icon), label, pending).build();
  }

  private void updateNotification(String status, boolean isPlaying) {
    NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(NOTIFY_ID, buildNotification(status, isPlaying));
  }

  private void updateSession() {
    if (session == null) return;
    int state = playing
        ? PlaybackState.STATE_PLAYING
        : (paused ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_STOPPED);
    long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
        | PlaybackState.ACTION_STOP;
    session.setPlaybackState(new PlaybackState.Builder()
        .setActions(actions)
        .setState(state, index, 1f)
        .build());
    session.setMetadata(new MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, title.isEmpty() ? "ShelfScout" : title)
        .build());
  }

  private void registerNoisy() {
    noisy = new BroadcastReceiver() {
      @Override
      public void onReceive(Context context, Intent intent) {
        if (playing) pause();
      }
    };
    IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
    try {
      registerReceiver(noisy, filter);
      noisyRegistered = true;
    } catch (Exception ignored) {
      /* not fatal */
    }
  }

  private String value(String text) {
    return text == null ? "" : text;
  }

  @Override
  public void onDestroy() {
    stopInternal();
    if (noisyRegistered && noisy != null) {
      try { unregisterReceiver(noisy); } catch (Exception ignored) { /* already gone */ }
      noisyRegistered = false;
    }
    if (session != null) {
      session.setActive(false);
      session.release();
      session = null;
    }
    if (tts != null) {
      try { tts.shutdown(); } catch (Exception ignored) { /* already gone */ }
      tts = null;
    }
    ttsReady = false;
    activeBook = "";
    activeState = "idle";
    listener = null;
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
