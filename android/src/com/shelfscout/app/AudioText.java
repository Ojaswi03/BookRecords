package com.shelfscout.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Text cleanup, front matter detection and sentence chunks for the offline reader. */
final class AudioText {
  static final int MAX_CHUNK = 350;

  private static final String[] STYLE_NAMES = {
      "Normal", "Gentle", "Calm", "Explaining", "Aggressive"
  };

  // Footer, licence and download boilerplate that free PDFs carry in front.
  private static final String[] META_WORDS = {
      "isbn", "copyright", "all rights reserved", "published by", "publisher",
      "printed in", "library of congress", "cataloguing", "cataloging", "eisbn",
      "first published", "typeset", "cover design", "cover image", "cover art",
      "project gutenberg", "release date", "last updated", "credits",
      "character set encoding", "produced by", "transcribed", "downloaded from",
      "this ebook", "this e-book", "terms of use", "creative commons",
      "licence", "license", "http://", "https://", "www.",
      "also by", "a note about the author", "edition"
  };

  private AudioText() {}

  /** One extracted line of a page, in points measured from the top left. */
  static final class Line {
    final String text;
    final float left;
    final float top;
    final float right;
    final float bottom;

    Line(String text, float left, float top, float right, float bottom) {
      this.text = text;
      this.left = left;
      this.top = top;
      this.right = right;
      this.bottom = bottom;
    }
  }

  /** One spoken piece and the lines it covers, used for the reading marker. */
  static final class Chunk {
    final String text;
    final List<Line> lines;

    Chunk(String text, List<Line> lines) {
      this.text = text;
      this.lines = lines;
    }
  }

  static String styleName(int style) {
    if (style < 0 || style >= STYLE_NAMES.length) return STYLE_NAMES[0];
    return STYLE_NAMES[style];
  }

  static float styleRate(int style) {
    switch (style) {
      case 1: return 0.92f;
      case 2: return 0.86f;
      case 3: return 0.95f;
      case 4: return 1.06f;
      default: return 1.0f;
    }
  }

  static float stylePitch(int style) {
    switch (style) {
      case 1: return 1.02f;
      case 2: return 0.98f;
      case 3: return 1.0f;
      case 4: return 0.90f;
      default: return 1.0f;
    }
  }

  /** Collapses the whitespace PDF extraction leaves inside one line. */
  static String tidy(String raw) {
    if (raw == null) return "";
    return raw.replace('\u00a0', ' ').replaceAll("\\s+", " ").trim();
  }

  /** The flat highlight rectangles of one chunk: left, top, right, bottom each. */
  static float[] boxes(Chunk chunk) {
    float[] out = new float[chunk.lines.size() * 4];
    for (int i = 0; i < chunk.lines.size(); i++) {
      Line line = chunk.lines.get(i);
      out[i * 4] = line.left;
      out[i * 4 + 1] = line.top;
      out[i * 4 + 2] = line.right;
      out[i * 4 + 3] = line.bottom;
    }
    return out;
  }

  static String join(List<Line> lines) {
    StringBuilder sb = new StringBuilder();
    for (Line line : lines) {
      if (line == null || line.text.isEmpty()) continue;
      if (sb.length() > 0) sb.append(' ');
      sb.append(line.text);
    }
    return sb.toString();
  }

  /**
   * Drops running heads, running feet and lone page numbers. A line only goes
   * when it sits on the edge of the sheet and repeats across many pages, so a
   * chapter title is never mistaken for one.
   */
  static void stripRunningHeads(List<List<Line>> pages, List<float[]> sizes) {
    Map<String, Integer> heads = new HashMap<>();
    Map<String, Integer> feet = new HashMap<>();

    for (int i = 0; i < pages.size(); i++) {
      List<Line> lines = pages.get(i);
      float height = sizeLine(sizes, i);
      if (lines.isEmpty()) continue;
      Line first = lines.get(0);
      if (inTopBand(first, height)) heads.merge(key(first.text), 1, Integer::sum);
      Line last = lines.get(lines.size() - 1);
      if (inBottomBand(last, height)) feet.merge(key(last.text), 1, Integer::sum);
    }

    int threshold = Math.max(3, (int) Math.ceil(pages.size() * 0.25));
    for (int i = 0; i < pages.size(); i++) {
      List<Line> lines = pages.get(i);
      float height = sizeLine(sizes, i);
      if (!lines.isEmpty()) {
        Line first = lines.get(0);
        if (inTopBand(first, height)
            && (calls(heads, key(first.text)) >= threshold || isPageNumber(first.text))) {
          lines.remove(0);
        }
      }
      if (!lines.isEmpty()) {
        Line last = lines.get(lines.size() - 1);
        if (inBottomBand(last, height)
            && (calls(feet, key(last.text)) >= threshold || isPageNumber(last.text))) {
          lines.remove(lines.size() - 1);
        }
      }
    }
  }

  /** How many leading pages are title, copyright or download boilerplate. */
  static int frontMatterPages(List<String> pages) {
    int limit = Math.min(pages.size(), 10);
    int skip = 0;
    for (int i = 0; i < limit; i++) {
      String text = pages.get(i) == null ? "" : pages.get(i);
      String lower = text.toLowerCase(Locale.ROOT);
      int hits = 0;
      for (String word : META_WORDS) {
        if (lower.contains(word)) hits++;
      }
      if (hits >= 2) {
        skip = i + 1;
        continue;
      }
      if (i < 3 && text.length() < 140) {
        skip = i + 1;
        continue;
      }
      if (hits >= 1 && text.length() < 1200) {
        skip = i + 1;
        continue;
      }
      break;
    }
    return skip;
  }

  /** Groups whole lines into pieces short enough for the phone's voice. */
  static List<Chunk> chunks(List<Line> lines) {
    List<Chunk> out = new ArrayList<>();
    if (lines == null) return out;
    List<Line> group = new ArrayList<>();
    StringBuilder text = new StringBuilder();

    for (Line line : lines) {
      if (line == null || line.text.isEmpty()) continue;
      if (line.text.length() > MAX_CHUNK) {
        flush(out, group, text);
        for (String piece : splitLong(line.text)) {
          List<Line> one = new ArrayList<>();
          one.add(line);
          out.add(new Chunk(piece, one));
        }
        continue;
      }
      if (text.length() > 0 && text.length() + 1 + line.text.length() > MAX_CHUNK) {
        flush(out, group, text);
      }
      if (text.length() > 0) text.append(' ');
      text.append(line.text);
      group.add(line);
      if (text.length() >= 140 && endsSentence(line.text)) flush(out, group, text);
    }
    flush(out, group, text);
    return out;
  }

  private static void flush(List<Chunk> out, List<Line> group, StringBuilder text) {
    if (text.length() == 0) return;
    out.add(new Chunk(text.toString(), new ArrayList<>(group)));
    group.clear();
    text.setLength(0);
  }

  private static boolean endsSentence(String line) {
    String text = line == null ? "" : line.trim();
    if (text.isEmpty()) return false;
    char last = text.charAt(text.length() - 1);
    if (last == '"' || last == '\'' || last == ')' || last == '\u201d') {
      if (text.length() < 2) return false;
      last = text.charAt(text.length() - 2);
    }
    return last == '.' || last == '!' || last == '?' || last == ':';
  }

  private static List<String> splitLong(String line) {
    List<String> out = new ArrayList<>();
    StringBuilder current = new StringBuilder();
    for (String word : line.split(" ")) {
      if (word.isEmpty()) continue;
      if (current.length() > 0 && current.length() + 1 + word.length() > MAX_CHUNK) {
        out.add(current.toString());
        current.setLength(0);
      }
      if (current.length() > 0) current.append(' ');
      current.append(word);
    }
    if (current.length() > 0) out.add(current.toString());
    return out;
  }

  private static String key(String text) {
    return text.toLowerCase(Locale.ROOT).replaceAll("[0-9]+", "#").replaceAll("\\s+", " ").trim();
  }

  private static int calls(Map<String, Integer> counts, String key) {
    Integer value = counts.get(key);
    return value == null ? 0 : value;
  }

  private static float sizeLine(List<float[]> sizes, int index) {
    if (index < 0 || index >= sizes.size()) return 842f;
    float[] size = sizes.get(index);
    return size != null && size.length > 1 && size[1] > 0 ? size[1] : 842f;
  }

  private static boolean inTopBand(Line line, float height) {
    return line != null && line.bottom <= height * 0.10f;
  }

  private static boolean inBottomBand(Line line, float height) {
    return line != null && line.top >= height * 0.90f;
  }

  private static boolean isPageNumber(String text) {
    String clean = text == null ? "" : text.trim().toLowerCase(Locale.ROOT);
    if (clean.isEmpty()) return false;
    return clean.matches("^[-\\u2013\\u2014]?\\s*[0-9]{1,4}\\s*[-\\u2013\\u2014]?$")
        || clean.matches("^[-\\u2013\\u2014]?\\s*[ivxlcdm]{1,7}\\s*[-\\u2013\\u2014]?$")
        || clean.matches("^page\\s+[0-9]{1,4}$");
  }
}
