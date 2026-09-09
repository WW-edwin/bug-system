"""Real browser probes. Run with: npx tsx tests/dictionaries-ui-runner.ts.

The runner provisions and removes a disposable local database. Every fixture is
owned by this run, including registrations, sessions, projects and issues.
"""
import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


BASE = os.environ.get("TEST_BASE_URL", "")
assert urlparse(BASE).hostname == "127.0.0.1", "Only isolated localhost tests allowed"
assert os.environ.get("TEST_DISPOSABLE_DATABASE", "").startswith("tracebug_dictionary_ui_"), "Use the disposable database runner"
MARKER = "SELFTEST-" + datetime.now().strftime("%Y%m%d-%H%M%S")
ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts" / "dictionary-ui"
ARTIFACTS.mkdir(parents=True, exist_ok=True)
PASSWORD = "DictionaryProbe123!"
ADMIN = "字典探针管理"
MEMBER = "字典探针成员"


def call(request, method, path, data=None, status=200):
    response = request.fetch(BASE + path, method=method, data=data,
                             headers={"Origin": BASE})
    assert response.status == status, f"{method} {path}: {response.status} {response.text()}"
    return response.json() if response.status != 204 else None


def register(context, name, suffix):
    return call(context.request, "POST", "/api/auth/register", {
        "name": name, "email": f"{MARKER.lower()}-{suffix}@kando.com.cn", "password": PASSWORD,
    }, 201)["user"]


def settings(page):
    page.get_by_role("navigation", name="管理导航").get_by_role("button", name="后台设置", exact=True).click()
    expect(page.get_by_role("heading", name="后台设置", exact=True)).to_be_visible()


def no_overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Horizontal document overflow"


def tab(page, name):
    page.get_by_role("tab", name=re.compile("^" + name)).click()
    expect(page.get_by_role("button", name="新增" + name, exact=True)).to_be_visible()


def save(page, kind):
    with page.expect_response(lambda response: response.url.endswith("/api/dictionaries/" + kind) and response.request.method == "PUT") as pending:
        page.get_by_role("button", name="保存设置", exact=True).click()
    response = pending.value
    assert response.status == 200, response.text()
    expect(page.get_by_role("button", name="保存设置", exact=True)).to_be_disabled()
    return response.json()


def dictionary_item(state, kind, label):
    return next(item for item in state["dictionaries"][kind] if item["label"] == label)


def name_input(page, label):
    return page.locator(".dictionary-name input").filter(visible=True).evaluate_all("xs=>xs.map(x=>x.value)").index(label)


def rename(page, old_label, new_label):
    index = name_input(page, old_label)
    page.locator(".dictionary-name input").nth(index).fill(new_label)


def weight(page, label, value):
    index = name_input(page, label)
    page.locator(".dictionary-weight input").nth(index).fill(str(value))


def visible_issue_ids(page):
    return page.locator(".issue-table tbody .issue-id").all_text_contents()


def navigate(page, label):
    page.get_by_role("navigation", name="主要导航").get_by_role("button", name=label, exact=True).click()


def workspace_issues(context):
    return call(context.request, "GET", "/api/workspace")["projects"][0]["issues"]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("PLAYWRIGHT_CHANNEL", "chrome"), headless=True)
        admin = browser.new_context(viewport={"width": 1440, "height": 1000})
        member = browser.new_context(viewport={"width": 1440, "height": 1000})
        anonymous = p.request.new_context()
        errors = []
        page = admin.new_page()
        page.set_default_timeout(8000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            call(anonymous, "GET", "/api/dictionaries", status=401)
            admin_user = register(admin, ADMIN, "admin")
            member_user = register(member, MEMBER, "member")
            assert admin_user["role"] == "admin" and member_user["role"] == "member"
            page.goto(BASE)
            page.wait_for_load_state("networkidle")
            settings(page)  # Admin settings remain reachable before the first project.
            project = call(admin.request, "POST", "/api/projects", {
                "name": MARKER, "key": "DICT", "description": MARKER,
            }, 201)["project"]
            page.goto(BASE)
            page.wait_for_load_state("networkidle")
            if os.environ.get("TEST_UI_RECON") == "1":
                print(json.dumps({"buttons": page.locator("button").all_text_contents(), "inputs": page.locator("input").evaluate_all("xs=>xs.map(x=>({type:x.type,label:x.getAttribute('aria-label'),placeholder:x.placeholder}))")}, ensure_ascii=False))
                if page.get_by_role("button", name="后台设置", exact=True).count():
                    settings(page)
                    print(page.locator(".dictionary-settings").inner_text())
                    print(page.locator("input").evaluate_all("xs=>xs.map(x=>({type:x.type,label:x.getAttribute('aria-label'),placeholder:x.placeholder}))"))
                page.screenshot(path=str(ARTIFACTS / "recon.png"), full_page=True)
                print("Reconnaissance complete; feature assertions have not run.")
                return
            run_checks(page, admin, member, project, admin_user, member_user)
            assert not errors, errors
            print("Dictionary UI probes passed; no uncaught browser errors.")
        except Exception:
            page.screenshot(path=str(ARTIFACTS / "failure.png"), full_page=True)
            print(page.locator("body").inner_text())
            raise
        finally:
            call(admin.request, "POST", "/api/auth/logout")
            call(member.request, "POST", "/api/auth/logout")
            anonymous.dispose()
            member.close()
            admin.close()
            browser.close()


def run_checks(page, admin, member, project, admin_user, member_user):
    member_page = member.new_page()
    member_page.goto(BASE)
    member_page.wait_for_load_state("networkidle")
    expect(member_page.get_by_role("button", name="后台设置", exact=True)).to_have_count(0)
    initial = call(member.request, "GET", "/api/dictionaries")
    call(member.request, "PUT", "/api/dictionaries/priority", {
        "version": initial["dictionaryVersions"]["priority"], "items": initial["dictionaries"]["priority"],
    }, 403)
    member_page.close()
    settings(page)
    no_overflow(page)
    page.screenshot(path=str(ARTIFACTS / "settings-desktop.png"), full_page=True)

    # Duplicate validation and a dirty-tab warning are exercised through the UI.
    page.get_by_label("优先级名称 1", exact=True).fill("P1")
    page.get_by_role("button", name="保存设置", exact=True).click()
    expect(page.get_by_role("alert").filter(has_text="重复")).to_be_visible()
    page.get_by_role("button", name="取消修改", exact=True).click()
    page.get_by_label("优先级名称 1", exact=True).fill("未保存名称")
    page.get_by_role("tab", name=re.compile("^环境")).click()
    expect(page.get_by_role("alert").filter(has_text="未保存")).to_be_visible()
    page.get_by_role("button", name="继续编辑", exact=True).click()
    expect(page.get_by_label("优先级名称 1", exact=True)).to_have_value("未保存名称")
    page.get_by_role("tab", name=re.compile("^环境")).click()
    page.get_by_role("button", name="放弃并切换", exact=True).click()
    expect(page.get_by_role("button", name="新增环境", exact=True)).to_be_visible()

    # Weight validation must reject values without silently changing them.
    tab(page, "优先级")
    for invalid_weight in ["", "-1", "1.5", "1000000"]:
        page.get_by_label("优先级权重 1", exact=True).fill(invalid_weight)
        page.get_by_role("button", name="保存设置", exact=True).click()
        expect(page.get_by_role("alert").filter(has_text="整数权重")).to_be_visible()
        page.get_by_role("button", name="取消修改", exact=True).click()

    custom = {"priority": "探针高优先", "environment": "探针环境", "status": "探针处理中"}
    titles = {"priority": "优先级", "environment": "环境", "status": "状态"}
    for kind, label in custom.items():
        tab(page, titles[kind])
        page.get_by_role("button", name="新增" + titles[kind], exact=True).click()
        page.locator(".dictionary-name input").last.fill(label)
        page.get_by_role("radio", name="将" + label + "设为默认值", exact=True).check()
        weight(page, label, 900000)
        state = save(page, kind)
        item = dictionary_item(state, kind, label)
        assert item["active"] and item["isDefault"]
        assert item["weight"] == 900000
        assert state["dictionaries"][kind][0]["label"] == label
        expect(page.locator(".dictionary-name input").first).to_have_value(label)
        assert item["showInPersonal"] == (kind == "status")

    page.get_by_role("button", name="新增状态", exact=True).click()
    page.locator(".dictionary-name input").last.fill("探针已结束")
    page.get_by_role("checkbox", name="探针已结束为已结束状态", exact=True).check()
    # Changing terminal semantics does not implicitly change personal visibility.
    expect(page.get_by_role("checkbox", name="探针已结束在个人中心展示", exact=True)).to_be_checked()
    page.get_by_role("checkbox", name="探针已结束在个人中心展示", exact=True).uncheck()
    state = save(page, "status")
    values = {kind: dictionary_item(state, kind, label)["value"] for kind, label in custom.items()}
    terminal = dictionary_item(state, "status", "探针已结束")["value"]
    assert dictionary_item(state, "status", "探针已结束")["isTerminal"]
    expect(page.get_by_role("radio", name="将探针已结束设为默认值", exact=True)).to_be_disabled()
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(ARTIFACTS / "settings-status-desktop.png"), full_page=True)

    navigate(page, "缺陷中心")
    page.get_by_role("button", name="新建缺陷", exact=True).first.click()
    dialog = page.get_by_role("dialog", name="新建缺陷", exact=True)
    expect(dialog.get_by_role("combobox", name="优先级", exact=True)).to_have_value(values["priority"])
    expect(dialog.get_by_role("combobox", name="环境", exact=True)).to_have_value(values["environment"])
    for kind in ["priority", "environment"]:
        expect(dialog.get_by_role("combobox", name=titles[kind], exact=True).locator("option").first).to_have_text(custom[kind])
    if dialog.get_by_role("combobox", name="状态", exact=True).count():
        expect(dialog.get_by_role("combobox", name="状态", exact=True)).to_have_value(values["status"])
    dialog.get_by_label("缺陷标题", exact=True).fill(MARKER + "-浏览器新增")
    assignee = dialog.get_by_role("button", name="负责人", exact=True)
    expect(assignee).to_contain_text("请选择负责人")
    dialog.get_by_role("button", name="创建缺陷", exact=True).click()
    expect(dialog.get_by_role("alert")).to_have_text("请选择至少一名负责人")
    assignee.click()
    dialog.get_by_role("option", name=admin_user["name"], exact=True).click()
    dialog.get_by_label("缺陷标题", exact=True).click()
    with page.expect_response(lambda response: response.url.endswith("/issues") and response.request.method == "POST") as pending:
        dialog.get_by_role("button", name="创建缺陷", exact=True).click()
    assert pending.value.status == 201, pending.value.text()
    issue1 = pending.value.json()["issue"]
    assert all(issue1[kind] == value for kind, value in values.items())
    expect(dialog).not_to_be_visible()
    if page.get_by_role("dialog", name=re.compile("详情$")).count():
        page.get_by_role("dialog", name=re.compile("详情$")).get_by_role("button", name="关闭详情", exact=True).last.click()
    issue2 = call(admin.request, "POST", f"/api/projects/{project['id']}/issues", {
        "title": MARKER + "-批量验证", "description": "<p>自测</p>", **values,
        "module": MARKER, "assigneeIds": [admin_user["id"]],
    }, 201)["issue"]
    page.reload()
    page.wait_for_load_state("networkidle")

    # A custom terminal status must affect single updates, batch updates and counts.
    page.get_by_role("button", name=issue1["id"] + " 状态", exact=True).click()
    menu = page.get_by_role("listbox", name=issue1["id"] + " 状态", exact=True)
    page.wait_for_timeout(220)  # Wait for the menu's page-scroll listener to attach.
    assert menu.evaluate("e => e.scrollHeight > e.clientHeight"), "Fixture must exercise a scrollable menu"
    menu.evaluate("e => e.scrollTop = 0")
    menu.hover()
    page.mouse.wheel(0, 450)
    page.wait_for_function("document.querySelector('.status-select-menu')?.scrollTop > 0")
    expect(menu).to_be_visible()
    with page.expect_response(lambda response: response.url.endswith("/issues/" + issue1["id"]) and response.request.method == "PATCH") as pending:
        page.get_by_role("option", name="探针已结束", exact=True).click()
    assert pending.value.status == 200, pending.value.text()
    expect(page.locator(".personal-center-button small")).to_have_text("负责 1 条缺陷")
    page.set_viewport_size({"width": 1440, "height": 360})
    page.get_by_role("button", name=issue1["id"] + " 状态", exact=True).click()
    expect(menu).to_be_visible()
    page.wait_for_timeout(220)
    page.mouse.move(1380, 180)
    old_scroll = page.evaluate("window.scrollY")
    page.mouse.wheel(0, 250)
    page.wait_for_function("previous => window.scrollY !== previous", arg=old_scroll)
    expect(menu).not_to_be_visible()
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.evaluate("window.scrollTo(0, 0)")
    page.get_by_role("checkbox", name="选择当前页可修改的缺陷", exact=True).check()
    page.get_by_label("批量目标状态", exact=True).select_option(terminal)
    page.get_by_role("button", name="应用状态", exact=True).click()
    confirmation = page.get_by_role("dialog", name="批量修改状态", exact=True)
    expect(confirmation.get_by_text("探针已结束", exact=True)).to_be_visible()
    with page.expect_response(lambda response: response.url.endswith("/issues/batch/status")) as pending:
        confirmation.get_by_role("button", name="确认修改", exact=True).click()
    assert pending.value.status == 200, pending.value.text()
    expect(confirmation).not_to_be_visible()
    assert all(issue["status"] == terminal for issue in workspace_issues(admin))
    expect(page.locator(".personal-center-button small")).to_have_text("负责 0 条缺陷")
    navigate(page, "项目概览")
    resolved_stat = page.locator(".stat-block").filter(has_text="累计完成")
    print("Overview stats:", page.locator(".stat-block").all_text_contents())
    expect(resolved_stat.locator("strong")).to_have_text("2")
    page.locator(".personal-center-button").click()
    expect(page.get_by_text(issue1["title"], exact=True)).to_have_count(0)
    expect(page.get_by_text(issue2["title"], exact=True)).to_have_count(0)

    # Renaming display labels cannot rewrite stored issue values or activity history.
    before = workspace_issues(admin)
    settings(page)
    renamed = {"priority": "探针高优先改名", "environment": "探针环境改名", "status": "探针结束改名"}
    originals = {**custom, "status": "探针已结束"}
    defaults = {"priority": "P1", "environment": "测试环境", "status": "待处理"}
    for kind, new_label in renamed.items():
        tab(page, titles[kind])
        rename(page, originals[kind], new_label)
        save(page, kind)
    assert workspace_issues(admin) == before, "Dictionary rename rewrote existing issues or activities"
    for kind, label in renamed.items():
        tab(page, titles[kind])
        page.get_by_role("radio", name="将" + defaults[kind] + "设为默认值", exact=True).check()
        page.get_by_role("checkbox", name="启用" + label, exact=True).uncheck()
        save(page, kind)
    assert workspace_issues(admin) == before, "Disabling dictionary changed historical issues"
    navigate(page, "缺陷中心")
    row = page.get_by_role("row").filter(has_text=issue1["title"])
    for label in renamed.values():
        expect(row.get_by_text(label, exact=True)).to_be_visible()
    row.get_by_role("button", name=issue1["id"] + " 状态", exact=True).click()
    expect(page.get_by_role("option", name=renamed["status"], exact=True)).to_have_count(0)
    page.keyboard.press("Escape")
    page.get_by_role("button", name="新建缺陷", exact=True).first.click()
    dialog = page.get_by_role("dialog", name="新建缺陷", exact=True)
    for kind in ["priority", "environment"]:
        expect(dialog.get_by_role("option", name=renamed[kind], exact=True)).to_have_count(0)
    dialog.get_by_role("button", name="取消", exact=True).click()
    page.get_by_role("button", name="状态筛选", exact=True).click()
    page.get_by_role("checkbox", name=renamed["status"], exact=True).check()
    page.get_by_role("button", name="状态筛选", exact=True).click()
    expect(page.locator(".result-count")).to_have_text("2 条结果")
    row.get_by_text(issue1["title"], exact=True).click()
    details = page.get_by_role("dialog", name=issue1["id"] + " 详情", exact=True)
    expect(details.get_by_role("combobox", name="优先级", exact=True)).to_have_value(values["priority"])
    expect(details.get_by_role("option", name=renamed["priority"] + "（已停用）", exact=True)).to_have_js_property("disabled", True)
    expect(details.get_by_role("combobox", name="运行环境", exact=True)).to_have_value(values["environment"])
    expect(details.get_by_role("option", name=renamed["environment"] + "（已停用）", exact=True)).to_have_js_property("disabled", True)
    details.get_by_role("button", name="关闭详情", exact=True).last.click()
    page.get_by_role("button", name="看板视图", exact=True).click()
    expect(page.get_by_text(issue1["title"], exact=True)).to_be_visible()
    expect(page.get_by_text(issue2["title"], exact=True)).to_be_visible()

    run_weight_and_personal_checks(page, admin, member, project, admin_user, member_user, [issue1, issue2])

    # Two editors cannot overwrite each other silently.
    settings(page)
    tab(page, "优先级")
    page.get_by_label("优先级名称 1", exact=True).fill("尚未提交的本地草稿")
    current = call(admin.request, "GET", "/api/dictionaries")
    entries = current["dictionaries"]["priority"]
    entries[0]["label"] = "另一管理员的修改"
    call(admin.request, "PUT", "/api/dictionaries/priority", {
        "version": current["dictionaryVersions"]["priority"], "items": entries,
    })
    with page.expect_response(lambda response: response.url.endswith("/api/dictionaries/priority")) as pending:
        page.get_by_role("button", name="保存设置", exact=True).click()
    assert pending.value.status == 409
    expect(page.get_by_role("alert").filter(has_text="其他管理员")).to_be_visible()
    expect(page.get_by_label("优先级名称 1", exact=True)).to_have_value("尚未提交的本地草稿")
    page.get_by_role("button", name="取消修改", exact=True).click()
    page.reload()
    page.wait_for_load_state("networkidle")
    settings(page)
    tab(page, "状态")
    for width in [900, 740]:
        page.set_viewport_size({"width": width, "height": 1000})
        page.wait_for_function("document.querySelector('.sidebar').getBoundingClientRect().right <= 0")
        page.evaluate("window.scrollTo(0, 0)")
        no_overflow(page)
        name_width = page.locator(".dictionary-name input").first.bounding_box()["width"]
        assert name_width >= 170, f"Dictionary name is too narrow at {width}px: {name_width}"
        page.screenshot(path=str(ARTIFACTS / f"settings-{width}.png"))
        print(f"Responsive {width}px: name input {name_width}px, no horizontal document overflow.")
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_function("document.querySelector('.sidebar').getBoundingClientRect().right <= 0")
    page.evaluate("window.scrollTo(0, 0)")
    no_overflow(page)
    page.screenshot(path=str(ARTIFACTS / "settings-mobile.png"))
    page.get_by_role("button", name="新增状态", exact=True).click()
    long_label = "移动端状态验证" + "测" * 33
    assert len(long_label) == 40
    page.locator(".dictionary-name input").last.fill(long_label)
    weight(page, long_label, 12345)
    page.get_by_role("checkbox", name=long_label + "在个人中心展示", exact=True).uncheck()
    page.locator(".dictionary-name input").last.scroll_into_view_if_needed()
    no_overflow(page)
    save(page, "status")
    mobile_state = call(admin.request, "GET", "/api/dictionaries")
    mobile_item = dictionary_item(mobile_state, "status", long_label)
    assert mobile_item["active"] and mobile_item["weight"] == 12345 and not mobile_item["showInPersonal"]
    page.locator(".dictionary-name input").nth(name_input(page, long_label)).scroll_into_view_if_needed()
    page.screenshot(path=str(ARTIFACTS / "settings-mobile-edited.png"), animations="disabled")
    print("Passed: admin/member access, duplicate/dirty/conflict protection, all 3 dictionary weights and option order, create/single/batch, status/priority/time sorting across pagination, independent personal visibility and assignee matching, terminal counts, disabled history and mobile editing.")


def run_weight_and_personal_checks(page, admin, member, project, admin_user, member_user, historical):
    before = workspace_issues(admin)
    settings(page)
    tab(page, "优先级")
    weight(page, "P0", 990000)
    weight(page, "P1", 999999)
    state = save(page, "priority")
    assert [item["label"] for item in state["dictionaries"]["priority"][:2]] == ["P1", "P0"]
    tab(page, "环境")
    weight(page, "测试环境", 999998)
    weight(page, "正式环境", 999999)
    state = save(page, "environment")
    assert [item["label"] for item in state["dictionaries"]["environment"][:2]] == ["正式环境", "测试环境"]
    tab(page, "状态")
    # A disabled historical status may still be included in personal pages.
    page.get_by_role("checkbox", name="探针结束改名在个人中心展示", exact=True).check()
    # A default, active, nonterminal status can independently be excluded.
    page.get_by_role("checkbox", name="待处理在个人中心展示", exact=True).uncheck()
    state = save(page, "status")
    history_status = dictionary_item(state, "status", "探针结束改名")
    assert history_status["showInPersonal"] and history_status["isTerminal"] and not history_status["active"]
    default_status = dictionary_item(state, "status", "待处理")
    assert default_status["isDefault"] and default_status["active"] and not default_status["showInPersonal"]
    assert workspace_issues(admin) == before, "Weight or visibility changes rewrote historical issues"
    expect(page.locator(".personal-center-button small")).to_have_text("负责 2 条缺陷")

    for label, item_weight, terminal, personal in [
        ("权重状态甲", 999999, False, False),
        ("权重状态乙", 999999, True, True),
        ("权重状态丙", 990000, False, True),
    ]:
        page.get_by_role("button", name="新增状态", exact=True).click()
        page.locator(".dictionary-name input").last.fill(label)
        weight(page, label, item_weight)
        page.get_by_role("checkbox", name=label + "为已结束状态", exact=True).set_checked(terminal)
        page.get_by_role("checkbox", name=label + "在个人中心展示", exact=True).set_checked(personal)
    state = save(page, "status")
    status_a, status_b, status_c = [dictionary_item(state, "status", label)["value"] for label in ["权重状态甲", "权重状态乙", "权重状态丙"]]
    assert [item["label"] for item in state["dictionaries"]["status"][:3]] == ["权重状态甲", "权重状态乙", "权重状态丙"]

    def create(suffix, status, priority="P0", environment="测试环境", assignees=None):
        return call(admin.request, "POST", f"/api/projects/{project['id']}/issues", {
            "title": MARKER + "-" + suffix, "description": "<p>权重与个人中心自动化探针</p>",
            "status": status, "priority": priority, "environment": environment,
            "module": MARKER, "assigneeIds": assignees or [admin_user["id"]],
        }, 201)["issue"]

    priority_first = create("同状态权重按优先级领先", status_a, "P1")
    terminal_visible = create("结束状态仍展示个人中心", status_b, environment="正式环境")
    newer_first = create("低环境权重按更新时间领先", status_a)
    assert newer_first["updatedAt"] > terminal_visible["updatedAt"], "Fixtures need distinct modification timestamps"
    member_only = create("仅成员负责", status_c, "P1", assignees=[member_user["id"]])
    shared = create("共同负责", status_c, "P1", assignees=[admin_user["id"], member_user["id"]])
    hidden_default = create("默认状态不展示", default_status["value"])
    filler = [create(f"分页-{index:02}", status_c, assignees=[member_user["id"]]) for index in range(20)]
    expected_first = [priority_first["id"], newer_first["id"], terminal_visible["id"]]
    all_ids = {issue["id"] for issue in workspace_issues(admin)}

    page.reload()
    page.wait_for_load_state("networkidle")
    navigate(page, "缺陷中心")
    for title, expected in [("优先级", ["P1", "P0"]), ("环境", ["正式环境", "测试环境"]), ("状态", ["权重状态甲", "权重状态乙", "权重状态丙"])]:
        page.get_by_role("button", name=title + "筛选", exact=True).click()
        labels = page.locator(".multi-select-menu > label").all_text_contents()
        assert labels[:len(expected)] == expected, (title, labels)
        page.get_by_role("button", name=title + "筛选", exact=True).click()

    # Equal weights across distinct status values must reach priority and time
    # tie-breakers. Environment only orders its options, never the issue list.
    expect(page.locator(".issue-table tbody tr")).to_have_count(20)
    first_page = visible_issue_ids(page)
    assert first_page[:3] == expected_first, first_page
    page.get_by_role("button", name="缺陷下一页", exact=True).click()
    expect(page.locator(".issue-table tbody tr")).to_have_count(len(all_ids) - 20)
    second_page = visible_issue_ids(page)
    assert not set(first_page).intersection(second_page)
    assert set(first_page + second_page) == all_ids
    page.get_by_role("combobox", name="每页显示数量", exact=True).select_option("50")
    expect(page.locator(".issue-table tbody tr")).to_have_count(len(all_ids))
    assert visible_issue_ids(page) == first_page + second_page
    page.get_by_role("combobox", name="每页显示数量", exact=True).select_option("100")
    assert visible_issue_ids(page) == first_page + second_page

    page.get_by_role("button", name="看板视图", exact=True).click()
    assert page.locator(".board-column-header .status-pill").all_text_contents()[:3] == ["权重状态甲", "权重状态乙", "权重状态丙"]
    page.get_by_role("button", name="列表视图", exact=True).click()
    # A low-ranking issue moves immediately into the high-weight group after a
    # real single-status update, while priority still decides its position.
    promoted = filler[0]
    page.get_by_role("button", name=promoted["id"] + " 状态", exact=True).click()
    with page.expect_response(lambda response: response.url.endswith("/issues/" + promoted["id"]) and response.request.method == "PATCH") as pending:
        page.get_by_role("option", name="权重状态甲", exact=True).click()
    assert pending.value.status == 200, pending.value.text()
    expect(page.locator(".issue-table tbody .issue-id").nth(1)).to_have_text(promoted["id"])
    assert visible_issue_ids(page)[:4] == [priority_first["id"], promoted["id"], newer_first["id"], terminal_visible["id"]]
    page.screenshot(path=str(ARTIFACTS / "weights-issue-order.png"), full_page=True)

    page.locator(".personal-center-button").click()
    expected_admin = {issue["id"] for issue in historical} | {terminal_visible["id"], shared["id"]}
    assert set(visible_issue_ids(page)) == expected_admin
    expect(page.locator(".personal-center-button small")).to_have_text("负责 4 条缺陷")
    expect(page.locator(".personal-summary").get_by_text("权重状态乙", exact=True)).to_be_visible()
    expect(page.locator(".personal-summary").get_by_text("探针结束改名", exact=True)).to_be_visible()
    for label, count in [("负责总数", 4), ("权重状态乙", 1), ("权重状态丙", 1), ("探针结束改名", 2)]:
        summary = page.locator(".personal-summary > div").filter(has=page.get_by_text(label, exact=True))
        expect(summary.locator("strong")).to_have_text(str(count))
    for excluded in [priority_first, newer_first, member_only, hidden_default, promoted]:
        expect(page.get_by_text(excluded["title"], exact=True)).to_have_count(0)
    page.screenshot(path=str(ARTIFACTS / "personal-independent-status-flags.png"), full_page=True, animations="disabled")

    member_page = member.new_page()
    try:
        member_page.goto(BASE)
        member_page.wait_for_load_state("networkidle")
        member_page.locator(".personal-center-button").click()
        expected_member = {member_only["id"], shared["id"]} | {issue["id"] for issue in filler[1:]}
        assert set(visible_issue_ids(member_page)) == expected_member
        expect(member_page.locator(".personal-center-button small")).to_have_text("负责 21 条缺陷")
        for label, count in [("负责总数", 21), ("权重状态丙", 21)]:
            summary = member_page.locator(".personal-summary > div").filter(has=member_page.get_by_text(label, exact=True))
            expect(summary.locator("strong")).to_have_text(str(count))
    finally:
        member_page.close()
    print("Weight/personal probes: saved all 3 weights; ordered create/filter/board options; status-priority-time ordering; 20/50/100 pagination; immediate single-update reorder; terminal/disabled/default visibility independent; exact per-assignee lists.")


if __name__ == "__main__":
    main()
