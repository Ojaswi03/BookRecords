package com.shelfscout.app;

import java.util.ArrayList;
import java.util.List;

/** Text cleanup and sentence-sized chunks for the offline reader. */
final class AudioText {
  static final int MAX_CHUNK = 350;

  private static final String[] STYLE_NAMES = {
      "Normal", "Gentle", "Calm", "Explaining", "Aggressive"
  };

  private AudioText() {}

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

  /** Removes running heads, broken hyphenation and excess whitespace. */
  static String cleanPage(String raw) {
    if (raw == null) return "";
    String text = raw.replace("\r", "\n");
    text = text.replaceAll("(?iu)(\\p{L})-\\s*\\n\\s*(\\p{L})", "$1$2");
    text = text.replace('\u00a0', ' ');
    text = text.replaceAll("[\\t ]+", " ");
    text = text.replaceAll(" *\\n *", "\n");
    text = text.replaceAll("\\n{3,}", "\n\n");
    return text.trim();
  }

  /** Splits a page into chunks safely below Android's speech input limit. */
  static List<String> chunks(String raw) {
    List<String> out = new ArrayList<>();
    if (raw == null) return out;
    String text = raw.replaceAll("\\s+", " ").trim();
    if (text.isEmpty()) return out;

    String[] sentences = text.split("(?<=[.!?])\\s+");
    StringBuilder current = new StringBuilder();
    for (String sentence : sentences) {
      if (sentence.isEmpty()) continue;
      if (sentence.length() > MAX_CHUNK) {
        if (current.length() > 0) {
          out.add(current.toString());
          current.setLength(0);
        }
        splitLong(sentence, out);
        continue;
      }
      if (current.length() > 0 && current.length() + 1 + sentence.length() > MAX_CHUNK) {
        out.add(current.toString());
        current.setLength(0);
      }
      if (current.length() > 0) current.append(' ');
      current.append(sentence);
    }
    if (current.length() > 0) out.add(current.toString());
    return out;
  }

  private static void splitLong(String sentence, List<String> out) {
    StringBuilder current = new StringBuilder();
    for (String word : sentence.split(" ")) {
      if (word.isEmpty()) continue;
      if (current.length() > 0 && current.length() + 1 + word.length() > MAX_CHUNK) {
        out.add(current.toString());
        current.setLength(0);
      }
      if (current.length() > 0) current.append(' ');
      current.append(word);
    }
    if (current.length() > 0) out.add(current.toString());
  }
}
