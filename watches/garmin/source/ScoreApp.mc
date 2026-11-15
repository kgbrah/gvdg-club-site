import Toybox.Application;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Timer;
import Toybox.WatchUi;

class ScoreApp extends Application.AppBase {
    private var _session;
    private var _timer;

    function initialize() {
        AppBase.initialize();
        _session = new ScoreSession();
        _timer = new Timer.Timer();
    }

    function getInitialView() {
        _timer.start(_session.method(:tick), 2000, true);
        return [new CardView(_session), new CardControls(_session)];
    }

    function onStop(state) { _timer.stop(); }
}

class CardView extends WatchUi.View {
    private var _session;

    function initialize(session) {
        View.initialize();
        _session = session;
    }

    function onUpdate(dc) {
        dc.setColor(Graphics.COLOR_WHITE, 0x101914);
        dc.clear();
        var width = dc.getWidth();
        var height = dc.getHeight();
        var center = width / 2;
        var card = _session.state["card"];
        dc.setColor(0xAFF1AE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(center, height * 19 / 100, Graphics.FONT_SMALL, "GVDG", Graphics.TEXT_JUSTIFY_CENTER);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        if (card == null) {
            drawPairing(dc, center, height);
        } else {
            var hole = _session.currentHole();
            var putting = card["scoringStyle"].equals("putting");
            var title = (putting ? "Station " : "Hole ") + hole["hole"].toString();
            if (!putting) { title += "   Par " + hole["par"].toString(); }
            dc.drawText(center, height * 34 / 100, Graphics.FONT_MEDIUM, title, Graphics.TEXT_JUSTIFY_CENTER);
            var distance = hole["distanceFt"];
            if (distance != null && !putting) {
                dc.drawText(center, height * 48 / 100, Graphics.FONT_XTINY, distance.toString() + " ft listed", Graphics.TEXT_JUSTIFY_CENTER);
            }
            var pending = _session.state["queue"].size();
            var status = card["locked"] ? "Card closed" : "Select scores";
            if (_session.state["blocked"]) { status = "Review saved scores"; }
            else if (pending > 0) { status = pending.toString() + " edits saved"; }
            dc.drawText(center, height * 62 / 100, Graphics.FONT_SMALL, status, Graphics.TEXT_JUSTIFY_CENTER);
        }
        if (_session.notice.length() > 0) {
            dc.setColor(0xB5C9BC, Graphics.COLOR_TRANSPARENT);
            dc.drawText(center, height * 76 / 100, Graphics.FONT_XTINY, _session.notice, Graphics.TEXT_JUSTIFY_CENTER);
        }
    }

    private function drawPairing(dc, center, height) {
        var code = _session.state["code"];
        if (code.length() == 8) {
            var formatted = code.substring(0, 4) + " " + code.substring(4, 8);
            dc.drawText(center, height * 34 / 100, Graphics.FONT_MEDIUM, formatted, Graphics.TEXT_JUSTIFY_CENTER);
            dc.drawText(center, height * 49 / 100, Graphics.FONT_XTINY, PHONE_SITE, Graphics.TEXT_JUSTIFY_CENTER);
            dc.drawText(center, height * 61 / 100, Graphics.FONT_XTINY, "Scorecard: Pair a watch", Graphics.TEXT_JUSTIFY_CENTER);
        } else {
            dc.drawText(center, height * 40 / 100, Graphics.FONT_MEDIUM, "Pair a watch", Graphics.TEXT_JUSTIFY_CENTER);
            dc.drawText(center, height * 56 / 100, Graphics.FONT_XTINY, "Select to get a code", Graphics.TEXT_JUSTIFY_CENTER);
        }
    }
}

class CardControls extends WatchUi.BehaviorDelegate {
    private var _session;

    function initialize(session) {
        BehaviorDelegate.initialize();
        _session = session;
    }

    function onSelect() {
        if (_session.state["card"] == null && _session.state["code"].length() == 0 && !_session.storageFailed) {
            _session.pair();
        } else {
            var menu = new WatchUi.Menu2({ :title => "GVDG" });
            fillMenu(menu);
            WatchUi.pushView(menu, new CardMenu(_session), WatchUi.SLIDE_UP);
        }
        return true;
    }

    function onMenu() { return onSelect(); }

    function onNextPage() {
        if (_session.state["card"] == null) { return false; }
        _session.moveHole(1);
        return true;
    }

    function onPreviousPage() {
        if (_session.state["card"] == null) { return false; }
        _session.moveHole(-1);
        return true;
    }

    private function fillMenu(menu) {
        var card = _session.state["card"];
        var queue = _session.state["queue"];
        if (card == null) {
            if (!_session.storageFailed) {
                menu.addItem(new WatchUi.MenuItem("Check pairing", null, :sync, null));
                menu.addItem(new WatchUi.MenuItem("New code", null, :pair, null));
            }
        } else {
            var hole = _session.currentHole()["hole"];
            var targets = card["targets"];
            for (var index = 0; index < targets.size(); index += 1) {
                var target = targets[index];
                var selection = { "target" => target, "hole" => _session.currentHole() };
                menu.addItem(new WatchUi.MenuItem(target["name"], scoreText(target, hole), selection, null));
            }
            menu.addItem(new WatchUi.MenuItem("Next hole", null, :next, null));
            menu.addItem(new WatchUi.MenuItem("Previous hole", null, :previous, null));
            if (queue.size() > 0) { menu.addItem(new WatchUi.MenuItem("Saved edits", queue.size().toString(), :review, null)); }
            if (_session.state["blocked"]) { menu.addItem(new WatchUi.MenuItem("Load phone scores", "Replace watch edits", :reload, null)); }
            else { menu.addItem(new WatchUi.MenuItem("Sync scores", null, :sync, null)); }
        }
        if (_session.storageFailed && card != null) { menu.addItem(new WatchUi.MenuItem("Retry storage", null, :retry, null)); }
        if (card == null || _session.state["blocked"] || queue.size() == 0) {
            menu.addItem(new WatchUi.MenuItem("Clear saved card", null, :clear, null));
        }
    }

    private function scoreText(target, hole) {
        var vote = _session.voteFor(target, hole);
        var text = vote == null ? "Unentered" : "Your score: " + vote.toString();
        var consensus = target["scores"][hole.toString()];
        var conflicts = target["conflicts"];
        for (var index = 0; index < conflicts.size(); index += 1) {
            if (conflicts[index] == hole) { return text + " / Check card"; }
        }
        if (vote == null && consensus != null) { return "Card: " + consensus.toString(); }
        return text;
    }
}

class CardMenu extends WatchUi.Menu2InputDelegate {
    private var _session;

    function initialize(session) {
        Menu2InputDelegate.initialize();
        _session = session;
    }

    function onSelect(item) {
        var id = item.getId();
        if (id instanceof Dictionary) { chooseScore(id["target"], id["hole"]); return; }
        if (id == :review) { reviewEdits(); return; }
        if (id == :reload || id == :clear) {
            var action = id == :reload ? "Use phone scores" : "Clear card";
            var approval = new WatchUi.Menu2({ :title => action + "?" });
            approval.addItem(new WatchUi.MenuItem("Keep watch edits", null, :cancel, null));
            approval.addItem(new WatchUi.MenuItem(action, "Removes saved watch edits", id, null));
            WatchUi.pushView(approval, new ConfirmMenu(_session), WatchUi.SLIDE_UP);
            return;
        }
        WatchUi.popView(WatchUi.SLIDE_DOWN);
        if (id == :next) { _session.moveHole(1); }
        if (id == :previous) { _session.moveHole(-1); }
        if (id == :sync) { _session.forceSync(); }
        if (id == :pair) { _session.pair(); }
        if (id == :retry) { _session.retryStorage(); }
    }

    private function chooseScore(target, hole) {
        if (!_session.canEdit()) { return; }
        var putting = _session.state["card"]["scoringStyle"].equals("putting");
        var min = putting ? 0 : 1;
        var par = hole["par"];
        var max = putting ? (par < 10 ? par : 10) : 30;
        var menu = new WatchUi.Menu2({ :title => target["name"] });
        for (var score = min; score <= max; score += 1) {
            menu.addItem(new WatchUi.MenuItem(score.toString(), null, score, null));
        }
        menu.addItem(new WatchUi.MenuItem("Clear score", null, :clear, null));
        WatchUi.pushView(menu, new ScoreMenu(_session, target, hole["hole"]), WatchUi.SLIDE_UP);
    }

    private function reviewEdits() {
        var review = new ReviewMenu(_session, 0);
        WatchUi.pushView(review.build(), review, WatchUi.SLIDE_UP);
    }
}

class ReviewMenu extends WatchUi.Menu2InputDelegate {
    private var _session;
    private var _page;

    function initialize(session, page) {
        Menu2InputDelegate.initialize();
        _session = session;
        _page = page;
    }

    function build() {
        var menu = new WatchUi.Menu2({ :title => "Saved on watch" });
        var pending = _session.state["queue"];
        var targets = _session.state["card"]["targets"];
        var limit = (_page + 1) * 10;
        for (var index = _page * 10; index < pending.size() && index < limit; index += 1) {
            var edit = pending[index];
            var name = "Player";
            for (var row = 0; row < targets.size(); row += 1) {
                if (targets[row]["id"].equals(edit["targetId"])) { name = targets[row]["name"]; break; }
            }
            var strokes = edit["strokes"];
            var subtitle = "Hole " + edit["hole"].toString() + " / " + (strokes == null ? "Cleared" : strokes.toString());
            menu.addItem(new WatchUi.MenuItem(name, subtitle, :view, null));
        }
        if (_page > 0) { menu.addItem(new WatchUi.MenuItem("Previous edits", null, :previous, null)); }
        if (pending.size() > limit) { menu.addItem(new WatchUi.MenuItem("More edits", null, :next, null)); }
        return menu;
    }

    function onSelect(item) {
        var id = item.getId();
        if (id == :previous || id == :next) {
            var page = new ReviewMenu(_session, _page + (id == :next ? 1 : -1));
            WatchUi.switchToView(page.build(), page, WatchUi.SLIDE_IMMEDIATE);
        }
    }
}

class ScoreMenu extends WatchUi.Menu2InputDelegate {
    private var _session;
    private var _target;
    private var _hole;

    function initialize(session, target, hole) {
        Menu2InputDelegate.initialize();
        _session = session;
        _target = target;
        _hole = hole;
    }

    function onSelect(item) {
        var score = item.getId();
        _session.record(_target, _hole, score == :clear ? null : score);
        WatchUi.popView(WatchUi.SLIDE_DOWN);
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}

class ConfirmMenu extends WatchUi.Menu2InputDelegate {
    private var _session;

    function initialize(session) {
        Menu2InputDelegate.initialize();
        _session = session;
    }

    function onSelect(item) {
        var id = item.getId();
        WatchUi.popView(WatchUi.SLIDE_DOWN);
        if (id == :cancel) { return; }
        WatchUi.popView(WatchUi.SLIDE_DOWN);
        if (id == :reload) { _session.loadPhoneScores(); }
        if (id == :clear) { _session.clear(); }
    }
}
