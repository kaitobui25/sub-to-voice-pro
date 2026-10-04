"use strict";

// Offline comparison using measured TTS times, excluding caption/speaker setup.
// Assumes sequential synthesis and continuous rendering; it is not a browser benchmark.
const fs = require("node:fs");
const preparation = require("../lib/audio-preparation.js");
const log = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/, ""));
const videoStart = log.events.find((event) => event.type === "session_start").videoTime;
const sentences = log.sentences.filter((sentence) => sentence.end >= videoStart &&
  Number.isFinite(sentence.diagnostic?.ttsEnd) && Number.isFinite(sentence.diagnostic?.ttsStart))
  .map((sentence) => ({ ...sentence, cost: sentence.diagnostic.ttsEnd - sentence.diagnostic.ttsStart }));
if (!sentences.length) throw new Error("Log contains no completed TTS samples.");

function replay(adaptiveStartup, groupedResume) {
  const config = preparation.normalizeConfig({ adaptiveStartup, groupedResume, ...log.settings.audioPreparation });
  config.adaptiveStartup = adaptiveStartup;
  config.groupedResume = groupedResume;
  let elapsed = 0;
  const readyAt = sentences.map((sentence) => (elapsed += sentence.cost));
  let wall = readyAt[Math.min(1, sentences.length - 1)];
  let ratio = null;
  let observed = 0;
  function state(index, videoTime, phase) {
    while (observed < sentences.length && readyAt[observed] <= wall) {
      const sample = sentences[observed++];
      ratio = preparation.observe(ratio, sample.cost, sample.end - sample.start, config);
    }
    const prepared = sentences.map((sentence, offset) => ({ ...sentence, _buffer: readyAt[offset] <= wall ? {} : null }));
    return preparation.readiness(prepared, index, videoTime,
      preparation.targetSeconds(config, ratio, 1, phase));
  }
  if (adaptiveStartup) {
    while (!state(0, videoStart, "startup").ready) {
      wall = readyAt.find((value) => value > wall);
    }
  }
  const startupSeconds = wall;
  let video = videoStart;
  let pauseCount = 0;
  let pauseSeconds = 0;
  for (let index = 0; index < sentences.length; index += 1) {
    const target = Math.max(video, sentences[index].start);
    wall += target - video;
    video = target;
    if (readyAt[index] > wall) {
      const before = wall;
      wall = readyAt[index];
      if (groupedResume) {
        while (!state(index, video, "resume").ready) wall = readyAt.find((value) => value > wall);
      }
      pauseCount += 1;
      pauseSeconds += wall - before;
    }
  }
  return { adaptiveStartup, groupedResume, startupSeconds, pauseCount, pauseSeconds };
}

console.log(JSON.stringify({ videoId: log.videoId, samples: sentences.length,
  assumption: "Sequential synthesis; continuous render; measured completed cues only; excludes setup and audio scheduling.",
  results: [replay(false, false), replay(true, false), replay(false, true), replay(true, true)] }, null, 2));
