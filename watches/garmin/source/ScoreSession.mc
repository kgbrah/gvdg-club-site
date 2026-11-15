import Toybox.Application;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.System;
import Toybox.WatchUi;

class ScoreSession {
    var state;
    var busy = false;
    var notice = "";
    var storageFailed = false;
    var holeIndex = 0;
    private var _waitFrom = 0;
    private var _waitMs = 0;
    private var _job = :none;

    function initialize() {
        try {
            state = Application.Storage.getValue("gvdg-score-v1");
            if (state == null) { state = emptyState(); }
            chooseStartingHole();
        } catch (error) {
            state = emptyState();
            storageFailed = true;
            notice = "Saved card unavailable";
        }
    }

    function emptyState() {
        return { "token" => "", "code" => "", "card" => null, "queue" => [], "blocked" => false };
    }

    function copyOf(record) {
        var result = {};
        var keys = record.keys();
        for (var index = 0; index < keys.size(); index += 1) { result[keys[index]] = record[keys[index]]; }
        return result;
    }

    function persist(next) {
        try {
            Application.Storage.setValue("gvdg-score-v1", next);
            state = next;
            storageFailed = false;
            return true;
        } catch (error) {
            storageFailed = true;
            notice = "Watch storage unavailable";
            return false;
        }
    }

    function chooseStartingHole() {
        holeIndex = 0;
        var card = state["card"];
        if (card == null) { return; }
        var holes = card["holes"];
        for (var i = 0; i < holes.size(); i += 1) {
            if (holes[i]["hole"] == card["startingHole"]) { holeIndex = i; return; }
        }
    }

    function currentHole() {
        var card = state["card"];
        return card == null ? null : card["holes"][holeIndex];
    }

    function moveHole(delta) {
        var length = state["card"]["holes"].size();
        holeIndex = (holeIndex + length + delta) % length;
        WatchUi.requestUpdate();
    }

    function canEdit() {
        var card = state["card"];
        return card != null && !card["locked"] && !storageFailed && !state["blocked"];
    }

    function voteFor(target, hole) {
        var queue = state["queue"];
        for (var index = queue.size() - 1; index >= 0; index -= 1) {
            var edit = queue[index];
            if (edit["hole"] == hole && edit["targetId"].equals(target["id"]) && edit["binding"].equals(target["binding"])) {
                return edit["strokes"];
            }
        }
        return target["votes"][hole.toString()];
    }

    function record(target, hole, strokes) {
        if (!canEdit()) { return; }
        var queue = state["queue"];
        var previous = voteFor(target, hole);
        if (previous == strokes) { return; }
        if (queue.size() >= 72) {
            notice = "Sync before adding scores";
            WatchUi.requestUpdate();
            return;
        }
        var sequence = queue.size() > 0 ? queue[queue.size() - 1]["sequence"] : state["card"]["lastSequence"];
        var next = copyOf(state);
        next["queue"] = queue.slice(0, queue.size());
        next["queue"].add({
            "sequence" => sequence + 1, "targetId" => target["id"], "binding" => target["binding"],
            "hole" => hole, "previous" => previous, "strokes" => strokes
        });
        if (persist(next)) { forceSync(); }
        WatchUi.requestUpdate();
    }

    function forceSync() {
        _waitMs = 0;
        tick();
    }

    function tick() {
        if (busy || storageFailed || state["blocked"] || state["token"].length() == 0) { return; }
        if (_waitMs > 0 && System.getTimer() - _waitFrom < _waitMs) { return; }
        if (state["queue"].size() > 0) {
            call(:score, "score", Communications.HTTP_REQUEST_METHOD_POST, encodeScore(state["queue"][0]));
        } else {
            call(:card, "card", Communications.HTTP_REQUEST_METHOD_GET, null);
        }
    }

    function pair() {
        if (!busy && !storageFailed && state["card"] == null) {
            notice = "Requesting code";
            call(:pair, "pairings", Communications.HTTP_REQUEST_METHOD_POST, "{}");
        }
    }

    function loadPhoneScores() {
        if (!busy && state["token"].length() > 0) { call(:reload, "card", Communications.HTTP_REQUEST_METHOD_GET, null); }
    }

    function clear() {
        if (!busy && persist(emptyState())) {
            holeIndex = 0;
            notice = "";
        }
        WatchUi.requestUpdate();
    }

    function retryStorage() {
        if (persist(state)) { notice = ""; forceSync(); }
        WatchUi.requestUpdate();
    }

    private function waitFor(milliseconds) {
        _waitFrom = System.getTimer();
        _waitMs = milliseconds;
    }

    private function call(job, path, methodType, body) {
        busy = true;
        _job = job;
        var headers = { "Accept" => "application/json" };
        if (job != :pair) { headers["Authorization"] = "Bearer " + state["token"]; }
        var options = { :method => methodType, :headers => headers, :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON };
        if (body != null) {
            headers["Content-Type"] = "application/json";
            options[:body] = body;
        }
        try {
            Communications.makeWebRequest("https://auth." + PHONE_SITE + "/watch/" + path, null, options, method(:response));
        } catch (error) {
            response(0, null);
        }
        WatchUi.requestUpdate();
    }

    function response(status as Number, data as Communications.ContentType or Null) as Void {
        busy = false;
        var job = _job;
        _job = :none;
        if (job == :pair && status == 201 && data instanceof Dictionary && data["code"] != null && data["token"] != null) {
            var initial = emptyState();
            initial["code"] = data["code"];
            initial["token"] = data["token"];
            if (persist(initial)) { notice = ""; waitFor(3000); }
        } else if ((job == :card || job == :reload) && status == 200 && data instanceof Dictionary &&
                   data["holes"] != null && data["holes"].size() > 0 && data["targets"] != null) {
            var first = state["card"] == null;
            notice = "";
            if (first || job == :reload || changedCard(data)) {
                var next = copyOf(state);
                next["card"] = data;
                next["code"] = "";
                if (job == :reload) { next["queue"] = []; next["blocked"] = false; }
                if (persist(next) && (first || holeIndex >= data["holes"].size())) { chooseStartingHole(); }
            }
            waitFor(state["queue"].size() > 0 ? 0 : 15000);
        } else if (job == :score && status == 200 && data instanceof Dictionary && data["sequence"] == state["queue"][0]["sequence"]) {
            acknowledge();
            waitFor(0);
        } else if (job == :card && state["card"] == null && status == 409) {
            waitFor(5000);
        } else if (job == :card && state["card"] == null && status == 401) {
            if (persist(emptyState())) { notice = "Code expired"; }
        } else if (job == :pair || status <= 0 || status >= 500 || status == 429 || status == 200) {
            notice = state["queue"].size() > 0 ? "Waiting to sync" : "Connect to continue";
            waitFor(status == 429 ? 60000 : 15000);
        } else {
            var blocked = copyOf(state);
            blocked["blocked"] = true;
            if (persist(blocked)) { notice = status == 401 ? "Watch access ended" : "Review saved scores"; }
        }
        WatchUi.requestUpdate();
    }

    private function changedCard(snapshot) {
        var cached = state["card"];
        return cached["revision"] == null || cached["revision"] != snapshot["revision"] ||
            cached["lastSequence"] != snapshot["lastSequence"] || cached["locked"] != snapshot["locked"];
    }

    private function acknowledge() {
        var next = copyOf(state);
        var queue = state["queue"];
        var edit = queue[0];
        var card = copyOf(state["card"]);
        var targets = card["targets"].slice(0, card["targets"].size());
        for (var index = 0; index < targets.size(); index += 1) {
            var target = targets[index];
            if (target["id"].equals(edit["targetId"]) && target["binding"].equals(edit["binding"])) {
                var updated = copyOf(target);
                var votes = copyOf(target["votes"]);
                var key = edit["hole"].toString();
                if (edit["strokes"] == null) { votes.remove(key); }
                else { votes[key] = edit["strokes"]; }
                updated["votes"] = votes;
                targets[index] = updated;
                break;
            }
        }
        card["targets"] = targets;
        card["lastSequence"] = edit["sequence"];
        next["card"] = card;
        next["queue"] = queue.size() == 1 ? [] : queue.slice(1, queue.size());
        if (persist(next)) { notice = ""; }
    }

    private function quote(text) {
        var output = "\"";
        var letters = text.toCharArray();
        for (var index = 0; index < letters.size(); index += 1) {
            var character = letters[index];
            var code = character.toNumber();
            if (code < 32) { output += "\\u" + code.format("%04x"); }
            else {
                if (code == 34 || code == 92) { output += "\\"; }
                output += character.toString();
            }
        }
        return output + "\"";
    }

    private function numeric(value) { return value == null ? "null" : value.toString(); }

    private function encodeScore(edit) {
        return "{\"sequence\":" + numeric(edit["sequence"]) + ",\"targetId\":" + quote(edit["targetId"]) +
            ",\"binding\":" + quote(edit["binding"]) + ",\"hole\":" + numeric(edit["hole"]) +
            ",\"previous\":" + numeric(edit["previous"]) + ",\"strokes\":" + numeric(edit["strokes"]) + "}";
    }
}
