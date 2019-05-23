const electron = require("electron");
const libtextmode = require("../js/libtextmode/libtextmode");
const canvas = require("../js/canvas.js");
const palette = require("../js/palette");
let doc, render;
let insert_mode = false;
let fg = 7;
let bg = 0;
const cursor = new canvas.Cursor();
let stored_blocks;
let undo_buffer = [];
let redo_buffer = [];
const mouse_button_types = {NONE: 0, LEFT: 1, RIGHT: 2};
let mouse_button = mouse_button_types.NONE;
let mouse_x, mouse_y;
const editor_modes = {SELECT: 0, BRUSH: 1, SAMPLE: 2};
let mode = editor_modes.SELECT;
let previous_mode;

function send_sync(channel, opts) {
    return electron.ipcRenderer.sendSync(channel, {id: electron.remote.getCurrentWindow().id, ...opts});
}

function send(channel, opts) {
    electron.ipcRenderer.send(channel, {id: electron.remote.getCurrentWindow().id, ...opts});
}

function reset_redo_buffer() {
    redo_buffer = [];
    send("disable_redo");
}

function reset_undo_buffer() {
    undo_buffer = [];
    send("disable_undo");
    reset_redo_buffer();
}

function update_menu_checkboxes() {
    send("update_menu_checkboxes", {insert_mode, use_9px_font: doc.use_9px_font, ice_colors: doc.ice_colors, actual_size: electron.remote.getCurrentWebContents().getZoomFactor() == 1, font_name: doc.font_name});
}

function update_status_bar() {
    document.getElementById("use_9px_font").textContent = doc.use_9px_font ? "On" : "Off";
    document.getElementById("ice_colors").textContent = doc.ice_colors ? "On" : "Off";
    document.getElementById("columns").textContent = `${doc.columns}`;
    document.getElementById("rows").textContent = `${doc.rows}`;
    document.getElementById("font_name").textContent = `${doc.font_name}`;
    document.getElementById("insert_mode").textContent = insert_mode ? "Ins" : "";
}

function set_fg(value) {
    palette.set_fg(value);
    fg = value;
}

function set_bg(value) {
    palette.set_bg(value);
    bg = value;
}

async function update_everything() {
    palette.add({palette: doc.palette, set_fg, set_bg});
    set_fg(fg);
    set_bg(bg);
    if (doc.data.length > 80 * 1000) {
        send_sync("show_rendering_modal");
        render = await libtextmode.render_split(doc);
        send("close_modal");
    } else {
        render = await libtextmode.render_split(doc);
    }
    update_menu_checkboxes();
    update_status_bar();
    canvas.add(render);
    if (doc.ice_colors) {
        canvas.stop_blinking();
    } else {
        canvas.start_blinking();
    }
    cursor.resize_to_font();
    cursor.show();
}

async function open_file({file}) {
    reset_undo_buffer();
    doc = await libtextmode.read_file(file);
    await update_everything();
    cursor.start_editing_mode();
}

function ice_colors(value) {
    doc.ice_colors = value;
    if (value) {
        canvas.stop_blinking();
    } else {
        canvas.start_blinking();
    }
    update_status_bar();
    update_menu_checkboxes();
}

function use_9px_font(value) {
    doc.use_9px_font = value;
    update_everything();
}

function set_var(name, value) {
    document.documentElement.style.setProperty(`--${name}`, `${value}px`);
}

function show_preview(visible) {
    set_var("preview-width", visible ? 300 : 1);
}

function show_statusbar(visible) {
    set_var("statusbar-height", visible ? 22 : 0);
}

function change_font(font_name) {
    doc.font_name = font_name;
    if (doc.font_bytes) delete doc.font_bytes;
    update_everything();
}

function set_insert_mode(value) {
    insert_mode = value;
    update_status_bar();
}

function export_as_png(file) {
    canvas.export_as_png({file, ice_colors: doc.ice_colors});
}

function previous_foreground_color() {
    set_fg(fg == 0 ? 15 : fg - 1);
}

function next_foreground_color() {
    set_fg(fg == 15 ? 0 : fg + 1);
}

function previous_background_colour() {
    set_bg(bg == 0 ? 15 : bg - 1);
}

function next_background_color() {
    set_bg(bg == 15 ? 0 : bg + 1);
}

function toggle_bg(num) {
    if (bg == num || (bg >= 8 && bg != num + 8)) {
        set_bg(num + 8);
    } else {
        set_bg(num);
    }
}

function toggle_fg(num) {
    if (fg == num || (fg >= 8 && fg != num + 8)) {
        set_fg(num + 8);
    } else {
        set_fg(num);
    }
}

function render_at(x, y) {
    canvas.render_at(x, y, doc.data[doc.columns * y + x]);
    if (cursor.x == x && cursor.y == y) cursor.draw();
}

function change_data({x, y, code, fg, bg, pre_cursor_x, pre_cursor_y}) {
    const i = doc.columns * y + x;
    if (pre_cursor_x != undefined && pre_cursor_y != undefined) {
        undo_buffer[undo_buffer.length - 1].push(Object.assign({x, y, pre_cursor_x, pre_cursor_y, post_cursor_x: cursor.x, post_cursor_y: cursor.y, ...doc.data[i]}));
    } else {
        undo_buffer[undo_buffer.length - 1].push(Object.assign({x, y, ...doc.data[i]}));
    }
    doc.data[i] = {code, fg, bg};
    render_at(x, y);
}

function start_undo_chunk() {
    reset_redo_buffer();
    undo_buffer.push([]);
    send("enable_undo");
    send("document_changed");
}

function key_typed(code) {
    start_undo_chunk();
    if (insert_mode) {
        for (let x = doc.columns - 1; x > cursor.x; x--) {
            const block = doc.data[doc.columns * cursor.y + x - 1];
            change_data({x, y: cursor.y, code: block.code, fg: block.fg, bg: block.bg});
        }
    }
    const x = cursor.x;
    cursor.right();
    change_data({x, y: cursor.y, code, fg, bg, pre_cursor_x: x, pre_cursor_y: cursor.y});
}

function backspace() {
    if (cursor.x > 0) {
        start_undo_chunk();
        const x = cursor.x;
        cursor.left();
        change_data({x: x - 1, y: cursor.y, code: 32, fg: 7, bg: 0, pre_cursor_x: x, pre_cursor_y: cursor.y});
    }
}

function delete_key() {
    start_undo_chunk();
    for (let x = cursor.x, i = cursor.index() + 1; x < doc.columns - 1; x++, i++) {
        const block = doc.data[i];
        change_data({x, y: cursor.y, code: block.code, fg: block.fg, bg: block.bg, pre_cursor_x: cursor.x, pre_cursor_y: cursor.y});
    }
    change_data({x: doc.columns - 1, y: cursor.y, code: 32, fg: 7, bg: 0});
}

function f_key(value) {
    key_typed([176, 177, 178, 219, 223, 220, 221, 222, 254, 249][value]);
}

function stamp(single_undo = false) {
    if (!single_undo) start_undo_chunk();
    for (let y = 0; y + cursor.y < doc.rows && y < stored_blocks.rows; y++) {
        for (let x = 0; x + cursor.x < doc.columns && x < stored_blocks.columns; x++) {
            const block = stored_blocks.data[y * stored_blocks.columns + x];
            change_data({x: cursor.x + x, y: cursor.y + y, code: block.code, fg: block.fg, bg: block.bg});
        }
    }
}

function place() {
    stamp(cursor.is_move_operation);
    cursor.start_editing_mode();
}

document.addEventListener("keydown", (event) => {
    switch (mode) {
        case editor_modes.SELECT:
            if (cursor.mode == canvas.cursor_modes.EDITING) {
                switch (event.code) {
                    case "F1": f_key(0); break;
                    case "F2": f_key(1); break;
                    case "F3": f_key(2); break;
                    case "F4": f_key(3); break;
                    case "F5": f_key(4); break;
                    case "F6": f_key(5); break;
                    case "F7": f_key(6); break;
                    case "F8": f_key(7); break;
                    case "F9": f_key(8); break;
                    case "F10": f_key(9);  break;
                    case "Backspace": backspace(); break;
                    case "Delete": delete_key(); break;
                    case "Enter":
                        cursor.new_line();
                        break;
                    default:
                        if (event.key.length == 1 && !event.metaKey && !event.altKey && !event.ctrlKey) {
                            if (event.key.length == 1) {
                                const code = event.key.charCodeAt(0);
                                if (code >= 32 && code <= 126) {
                                    key_typed(code);
                                    event.preventDefault();
                                }
                            }
                        }
                        break;
                }
            } else if (cursor.mode == canvas.cursor_modes.OPERATION && event.code == "Enter") {
                place();
            }
            switch (event.code) {
                case "ArrowLeft":
                    if (!event.altKey) {
                        if (event.shiftKey && cursor.mode != canvas.cursor_modes.SELECTION) cursor.start_selection_mode();
                        if (event.metaKey) {
                            cursor.start_of_row();
                        } else {
                            cursor.left();
                        }
                        event.preventDefault();
                    }
                    break;
                case "ArrowUp":
                    if (!event.altKey) {
                        if (event.shiftKey && cursor.mode != canvas.cursor_modes.SELECTION) cursor.start_selection_mode();
                        if (event.metaKey) {
                            cursor.page_up();
                        } else {
                            cursor.up();
                        }
                        event.preventDefault();
                    }
                    break;
                case "ArrowRight":
                    if (!event.altKey) {
                        if (event.shiftKey && cursor.mode != canvas.cursor_modes.SELECTION) cursor.start_selection_mode();
                        if (event.metaKey) {
                            cursor.end_of_row();
                        } else {
                            cursor.right();
                        }
                        event.preventDefault();
                    }
                    break;
                case "ArrowDown":
                    if (!event.altKey) {
                        if (event.shiftKey && cursor.mode != canvas.cursor_modes.SELECTION) cursor.start_selection_mode();
                        if (event.metaKey) {
                            cursor.page_down();
                        } else {
                            cursor.down();
                        }
                        event.preventDefault();
                    }
                    break;
                case "PageUp":
                    if (event.shiftKey && cursor.mode != canvas.cursor_modes.SELECTION) cursor.start_selection_mode();
                    cursor.page_up();
                    event.preventDefault();
                    break;
                case "PageDown":
                    if (event.shiftKey && cursor.mode != canvas.cursor_modes.SELECTION) cursor.start_selection_mode();
                    cursor.page_down();
                    event.preventDefault();
                    break;
                case "NumpadEnter":
                    set_insert_mode(!insert_mode);
                    update_menu_checkboxes();
                    break;
            }
            if (event.altKey && !event.metaKey && !event.ctrlKey) {
                switch (event.code) {
                    case "Digit0": toggle_fg(0); break;
                    case "Digit1": toggle_fg(1); break;
                    case "Digit2": toggle_fg(2); break;
                    case "Digit3": toggle_fg(3); break;
                    case "Digit4": toggle_fg(4); break;
                    case "Digit5": toggle_fg(5); break;
                    case "Digit6": toggle_fg(6); break;
                    case "Digit7": toggle_fg(7); break;
                }
            } else if (event.ctrlKey && !event.altKey && !event.metaKey) {
                switch (event.code) {
                    case "Digit0": toggle_bg(0); break;
                    case "Digit1": toggle_bg(1); break;
                    case "Digit2": toggle_bg(2); break;
                    case "Digit3": toggle_bg(3); break;
                    case "Digit4": toggle_bg(4); break;
                    case "Digit5": toggle_bg(5); break;
                    case "Digit6": toggle_bg(6); break;
                    case "Digit7": toggle_bg(7); break;
                }
            }
        break;
        default:
            break;
    }
}, true);

function save({file, close_on_save}) {
    libtextmode.write_file(doc, file);
    if (close_on_save) electron.remote.getCurrentWindow().close();
}

function deselect() {
    if (cursor.mode != canvas.cursor_modes.EDITING) {
        if (cursor.mode == canvas.cursor_modes.OPERATION) {
            if (cursor.is_move_operation) undo();
        }
        cursor.start_editing_mode();
    }
}

function clear_blocks({sx, sy, dx, dy}) {
    start_undo_chunk();
    for (let y = sy; y <= dy; y++) {
        for (let x = sx; x <= dx; x++) {
            change_data({x, y, code: 32, fg: 7, bg: 0});
        }
    }
}

function delete_selection() {
    if (cursor.mode == canvas.cursor_modes.SELECTION) {
        clear_blocks(cursor.reorientate_selection());
        cursor.start_editing_mode();
    }
}

function select_all() {
    if (mode != editor_modes.SELECT) {
        change_to_select_mode();
    }
    cursor.start_editing_mode();
    cursor.move_to(0, 0, true);
    cursor.start_selection_mode();
    cursor.move_to(doc.columns - 1, doc.rows - 1);
}

function copy_block() {
    if (cursor.mode == canvas.cursor_modes.SELECTION) {
        stored_blocks = cursor.start_operation_mode(doc.data);
    }
}

function move_block() {
    if (cursor.mode == canvas.cursor_modes.SELECTION) {
        const selection = cursor.reorientate_selection();
        stored_blocks = cursor.start_operation_mode(doc.data, true);
        clear_blocks(selection);
    }
}

function copy() {
    if (cursor.mode == canvas.cursor_modes.SELECTION) {
        stored_blocks = cursor.get_blocks_in_selection(doc.data);
        const text = [];
        for (let y = 0, i = 0; y < stored_blocks.rows; y++) {
            text.push("");
            for (let x = 0; x < stored_blocks.columns; x++, i++) {
                text[text.length - 1] += libtextmode.cp437_to_unicode(stored_blocks.data[i].code);
            }
        }
        electron.clipboard.write({text: text.join("\n"), html: JSON.stringify(stored_blocks)});
        cursor.start_editing_mode();
    }
}

function cut() {
    if (cursor.mode == canvas.cursor_modes.SELECTION) {
        const selection = cursor.reorientate_selection();
        copy();
        clear_blocks(selection);
    }
}

function paste() {
    try {
        const blocks = JSON.parse(electron.clipboard.readHTML().replace("<meta charset='utf-8'>", ""));
        if (blocks.columns && blocks.rows && (blocks.data.length == blocks.columns * blocks.rows)) {
            if (cursor.mode != canvas.cursor_modes.EDITING) cursor.start_editing_mode();
            start_undo_chunk();
            for (let y = 0; y + cursor.y < doc.rows && y < blocks.rows; y++) {
                for (let x = 0; x + cursor.x < doc.columns && x < blocks.columns; x++) {
                    const block = blocks.data[blocks.columns * y + x];
                    change_data({x: cursor.x + x, y: cursor.y + y, code: block.code, fg: block.fg, bg: block.bg});
                }
            }
        } else {
            throw("catch!");
        }
    } catch (err) {
        const text = electron.clipboard.readText();
        if (text.length) {
            if (cursor.mode != canvas.cursor_modes.EDITING) cursor.start_editing_mode();
            start_undo_chunk();
            const lines = text.split("\n");
            if (lines.length) {
                for (let y = cursor.y, line_y = 0; y < doc.rows && line_y < lines.length; y++, line_y++) {
                    for (let x = cursor.x, line_x = 0; x < doc.columns && line_x < lines[line_y].length; x++, line_x++) {
                        change_data({x, y, code: lines[line_y].charCodeAt(line_x), fg, bg});
                    }
                }
            }
        }
    }
}

function undo() {
    if (undo_buffer.length) {
        if (cursor.mode != canvas.cursor_modes.EDITING) cursor.start_editing_mode();
        const redos = [];
        const undos = undo_buffer.pop();
        for (let undo_i = undos.length - 1; undo_i >= 0; undo_i--) {
            const undo = undos[undo_i];
            const i = doc.columns * undo.y + undo.x;
            redos.push(Object.assign({...doc.data[i], x: undo.x, y: undo.y, pre_cursor_x: undo.pre_cursor_x, pre_cursor_y: undo.pre_cursor_y, post_cursor_x: undo.post_cursor_x, post_cursor_y: undo.post_cursor_y}));
            doc.data[i] = Object.assign(undo);
            render_at(undo.x, undo.y);
            if (undo.pre_cursor_x != undefined && undo.pre_cursor_y != undefined) {
                cursor.move_to(undo.pre_cursor_x, undo.pre_cursor_y, true);
            }
        }
        redo_buffer.push(redos);
        send("enable_redo");
        if (!undo_buffer.length) send("disable_undo");
    }
}

function redo() {
    if (redo_buffer.length) {
        if (cursor.mode != canvas.cursor_modes.EDITING) cursor.start_editing_mode();
        const undos = [];
        const redos = redo_buffer.pop();
        for (let redo_i = redos.length - 1; redo_i >= 0; redo_i--) {
            const redo = redos[redo_i];
            const i = doc.columns * redo.y + redo.x;
            undos.push(Object.assign({...doc.data[i], x: redo.x, y: redo.y, pre_cursor_x: redo.pre_cursor_x, pre_cursor_y: redo.pre_cursor_y, post_cursor_x: redo.post_cursor_x, post_cursor_y: redo.post_cursor_y}));
            doc.data[i] = Object.assign(redo);
            render_at(redo.x, redo.y);
            if (redo.post_cursor_x != undefined && redo.post_cursor_y != undefined) {
                cursor.move_to(redo.post_cursor_x, redo.post_cursor_y, true);
            }
        }
        undo_buffer.push(undos);
        send("enable_undo");
        if (!redo_buffer.length) send("disable_redo");
    }
}

function use_attribute_under_cursor() {
    const i = cursor.index();
    set_fg(doc.data[i].fg);
    set_bg(doc.data[i].bg);
}

function default_color() {
    set_fg(7);
    set_bg(0);
}

function switch_foreground_background() {
    const tmp = fg;
    set_fg(bg);
    set_bg(tmp);
}

function has_latest_undo_got_this_block(x, y) {
    for (const undo of undo_buffer[undo_buffer.length - 1]) {
        if (undo.x == x && undo.y == y) return true;
    }
    return false;
}

function optimize_block(x, y) {
    const i = y * doc.columns + x;
    const block = doc.data[i];
    if (block.bg >= 8 && block.fg < 8) {
        switch (block.code) {
        case 0: case 32: case 255: change_data({x, t, code: 219, fg: block.bg, bg: 0}); break;
        case 219: change_data({x, y, code: 0, fg: block.bg, bg: block.fg}); break;
        case 220: change_data({x, y, code: 223, fg: block.bg, bg: block.fg}); break;
        case 223: change_data({x, y, code: 220, fg: block.bg, bg: block.fg}); break;
        }
    }
}

function line(x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0);
    const sx = (x0 < x1) ? 1 : -1;
    const dy = Math.abs(y1 - y0);
    const sy = (y0 < y1) ? 1 : -1;
    let err = ((dx > dy) ? dx : -dy) / 2;
    let e2;
    const coords = [];

    while (true) {
        coords.push({x: x0, y: y0});
        if (x0 === x1 && y0 === y1) {
            break;
        }
        e2 = err;
        if (e2 > -dx) {
            err -= dy;
            x0 += sx;
        }
        if (e2 < dy) {
            err += dx;
            y0 += sy;
        }
    }
    return coords;
}

function half_block_brush(x, y, col) {
    const coords = line(mouse_x, mouse_y, x, y);
    for (const coord of coords) {
        const block_y = Math.floor(coord.y / 2);
        const i = block_y * doc.columns + coord.x;
        const block = doc.data[i];
        const is_top = (coord.y % 2) == 0;
        if (block.code == 219) {
            if (block.fg != col) {
                if (is_top) {
                    change_data({x: coord.x, y: block_y, code: 223, fg: col, bg: block.fg});
                } else {
                    change_data({x: coord.x, y: block_y, code: 220, fg: col, bg: block.fg});
                }
            }
        } else if (block.code != 220 && block.code != 223) {
            if (is_top) {
                change_data({x: coord.x, y: block_y, code: 223, fg: col, bg: block.bg});
            } else {
                change_data({x: coord.x, y: block_y, code: 220, fg: col, bg: block.bg});
            }
        } else {
            if (is_top) {
                if (block.code == 223) {
                    if (block.bg == col) {
                        change_data({x: coord.x, y: block_y, code: 219, fg: col, bg: 0});
                    } else {
                        change_data({x: coord.x, y: block_y, code: 223, fg: col, bg: block.bg});
                    }
                } else if (block.fg == col) {
                    change_data({x: coord.x, y: block_y, code: 219, fg: col, bg: 0});
                } else {
                    change_data({x: coord.x, y: block_y, code: 223, fg: col, bg: block.fg});
                }
            } else {
                if (block.code == 220) {
                    if (block.bg == col) {
                        change_data({x: coord.x, y: block_y, code: 219, fg: col, bg: 0});
                    } else {
                        change_data({x: coord.x, y: block_y, code: 220, fg: col, bg: block.bg});
                    }
                } else if (block.fg == col) {
                    change_data({x: coord.x, y: block_y, code: 219, fg: col, bg: 0});
                } else {
                    change_data({x: coord.x, y: block_y, code: 220, fg: col, bg: block.fg});
                }
            }
        }
        optimize_block(coord.x, block_y);
    }
    mouse_x = x;
    mouse_y = y;
}


function get_canvas_xy(event) {
    const canvas_container = document.getElementById("canvas_container");
    const canvas_container_rect = canvas_container.getBoundingClientRect();
    const x = Math.min(Math.max(Math.floor((event.clientX - canvas_container_rect.left) / render.font.width), 0), doc.columns - 1);
    const y = Math.min(Math.max(Math.floor((event.clientY - canvas_container_rect.top) / render.font.height), 0), doc.rows - 1);
    const half_y = Math.min(Math.max(Math.floor((event.clientY - canvas_container_rect.top) / (render.font.height / 2)), 0), doc.rows * 2 - 1);
    return {x, y, half_y};
}

function mouse_down(event) {
    const {x, y, half_y} = get_canvas_xy(event);
    if (event.button == 0) {
        mouse_button = mouse_button_types.LEFT;
    } else if (event.button == 2) {
        mouse_button = mouse_button_types.RIGHT;
    }
    switch (mode) {
        case editor_modes.SELECT:
            switch (cursor.mode) {
                case canvas.cursor_modes.EDITING:
                    mouse_x = x; mouse_y = y;
                    cursor.move_to(x, y);
                    break;
                case canvas.cursor_modes.SELECTION:
                    cursor.start_editing_mode();
                    cursor.move_to(x, y);
                    break;
                case canvas.cursor_modes.OPERATION:
                    cursor.move_to(x, y);
                    stamp(cursor.is_move_operation);
                    cursor.start_editing_mode();
                    break;
            }
        break;
        case editor_modes.BRUSH:
            start_undo_chunk();
            mouse_x = x; mouse_y = half_y;
            half_block_brush(x, half_y, (mouse_button == mouse_button_types.LEFT) ? fg : bg);
        break;
        case editor_modes.SAMPLE:
            const block = doc.data[doc.columns * y + x];
            set_fg(block.fg);
            set_bg(block.bg);
            switch (previous_mode) {
                case editor_modes.SELECT: change_to_select_mode(); break;
                case editor_modes.BRUSH: change_to_brush_mode(); break;
            }
        break;
    }
}

function mouse_move(event) {
    const {x, y, half_y} = get_canvas_xy(event);
    switch (mode) {
        case editor_modes.SELECT:
            switch (cursor.mode) {
                case canvas.cursor_modes.EDITING:
                    if (mouse_button) {
                        if (mouse_x != x || mouse_y != y) cursor.start_selection_mode();
                    }
                    break;
                case canvas.cursor_modes.SELECTION:
                    if (mouse_button) cursor.move_to(x, y);
                    break;
                case canvas.cursor_modes.OPERATION:
                    cursor.move_to(x, y);
                    break;
            }
        break;
        case editor_modes.BRUSH:
            if (mouse_button) half_block_brush(x, half_y, mouse_button == mouse_button_types.LEFT ? fg : bg);
            break;
    }
}

function mouse_up(event) {
    mouse_button = mouse_button_types.NONE;
}

function open_reference_image({image}) {
    document.getElementById("reference_image").style.backgroundImage = `url(${image})`;
}

function clear_reference_image() {
    document.getElementById("reference_image").style.removeProperty("background-image");
}

function rotate() {
    cursor.update_cursor_with_blocks(libtextmode.rotate(stored_blocks));
}

function flip_x() {
    cursor.update_cursor_with_blocks(libtextmode.flip_x(stored_blocks));
}

function flip_y() {
    cursor.update_cursor_with_blocks(libtextmode.flip_y(stored_blocks));
}

function center() {
    cursor.move_to(Math.max(Math.floor((doc.columns - stored_blocks.columns) / 2), 0), cursor.y);
}

function set_zoom(factor) {
    const zoom_element = document.getElementById("zoom");
    electron.remote.getCurrentWebContents().setZoomFactor(factor);
    zoom_element.textContent = `${Math.ceil(factor * 10) * 10}%`;
    zoom_element.classList.remove("fade");
    document.body.removeChild(zoom_element);
    document.body.appendChild(zoom_element);
    zoom_element.classList.add("fade");
    update_menu_checkboxes();
}

function current_zoom_factor() {
    return parseFloat(electron.remote.getCurrentWebContents().getZoomFactor().toFixed(1));
}

function zoom_in() {
    set_zoom(Math.min(current_zoom_factor() + 0.1, 3.0));
}

function zoom_out() {
    set_zoom(Math.max(current_zoom_factor() - 0.1, 0.4));
}

function actual_size() {
    set_zoom(1.0);
}

function get_canvas_size() {
    send("get_canvas_size", {columns: doc.columns, rows: doc.rows});
}

function set_canvas_size({columns, rows}) {
    if (columns != doc.columns | rows != doc.rows) {
        reset_undo_buffer();
        libtextmode.resize_canvas(doc, columns, rows);
        cursor.move_to(Math.min(cursor.x, columns - 1), Math.min(cursor.y, rows - 1), true);
        update_everything();
    }
}

function get_sauce_info() {
    send("get_sauce_info", {title: doc.title, author: doc.author, group: doc.group, comments: doc.comments});
}

function set_sauce_info({title, author, group, comments}) {
    doc.title = title;
    doc.author = author;
    doc.group = group;
    doc.comments = comments;
}

async function new_document({columns, rows}) {
    reset_undo_buffer();
    doc = libtextmode.new_document({columns, rows});
    await update_everything();
    cursor.start_editing_mode();
}

function change_to_select_mode() {
    switch (mode) {
        case editor_modes.BRUSH: document.getElementById("brush_mode").classList.remove("selected"); break;
        case editor_modes.SAMPLE: document.getElementById("sample_mode").classList.remove("selected"); break;
    }
    if (mode != editor_modes.SELECT) {
        document.getElementById("select_mode").classList.add("selected");
        cursor.show();
        cursor.start_editing_mode();
        send("enable_editing_shortcuts");
        mode = editor_modes.SELECT;
    }
}

function change_to_brush_mode() {
    switch (mode) {
        case editor_modes.SELECT:
            document.getElementById("select_mode").classList.remove("selected");
            cursor.hide();
            send("disable_editing_shortcuts");
            break;
        case editor_modes.SAMPLE: document.getElementById("sample_mode").classList.remove("selected"); break;
    }
    if (mode != editor_modes.BRUSH) {
        document.getElementById("brush_mode").classList.add("selected");
        mode = editor_modes.BRUSH;
        send("show_brush_touchbar");
    }
}

function change_to_sample_mode() {
    switch (mode) {
        case editor_modes.SELECT:
            document.getElementById("select_mode").classList.remove("selected");
            cursor.hide();
            send("disable_editing_shortcuts");
        break;
        case editor_modes.BRUSH:
            document.getElementById("brush_mode").classList.remove("selected");
        break;
    }
    if (mode != editor_modes.SAMPLE) {
        previous_mode = mode;
        document.getElementById("sample_mode").classList.add("selected");
        mode = editor_modes.SAMPLE;
    }
}

electron.ipcRenderer.on("open_file", (event, opts) => open_file(opts));
electron.ipcRenderer.on("save", (event, opts) => save(opts));
electron.ipcRenderer.on("show_statusbar", (event, opts) => show_statusbar(opts));
electron.ipcRenderer.on("show_preview", (event, opts) => show_preview(opts));
electron.ipcRenderer.on("ice_colors", (event, opts) => ice_colors(opts));
electron.ipcRenderer.on("use_9px_font", (event, opts) => use_9px_font(opts));
electron.ipcRenderer.on("change_font", (event, opts) => change_font(opts));
electron.ipcRenderer.on("insert_mode", (event, opts) => set_insert_mode(opts));
electron.ipcRenderer.on("export_as_png", (event, opts) => export_as_png(opts));
electron.ipcRenderer.on("previous_foreground_color", (event, opts) => previous_foreground_color(opts));
electron.ipcRenderer.on("next_foreground_color", (event, opts) => next_foreground_color(opts));
electron.ipcRenderer.on("previous_background_colour", (event, opts) => previous_background_colour(opts));
electron.ipcRenderer.on("next_background_color", (event, opts) => next_background_color(opts));
electron.ipcRenderer.on("deselect", (event, opts) => deselect(opts));
electron.ipcRenderer.on("select_all", (event, opts) => select_all(opts));
electron.ipcRenderer.on("copy_block", (event, opts) => copy_block(opts));
electron.ipcRenderer.on("move_block", (event, opts) => move_block(opts));
electron.ipcRenderer.on("stamp", (event, opts) => stamp(opts));
electron.ipcRenderer.on("rotate", (event, opts) => rotate(opts));
electron.ipcRenderer.on("flip_x", (event, opts) => flip_x(opts));
electron.ipcRenderer.on("flip_y", (event, opts) => flip_y(opts));
electron.ipcRenderer.on("center", (event, opts) => center(opts));
electron.ipcRenderer.on("cut", (event, opts) => cut(opts));
electron.ipcRenderer.on("copy", (event, opts) => copy(opts));
electron.ipcRenderer.on("paste", (event, opts) => paste(opts));
electron.ipcRenderer.on("delete_selection", (event, opts) => delete_selection(opts));
electron.ipcRenderer.on("undo", (event, opts) => undo(opts));
electron.ipcRenderer.on("redo", (event, opts) => redo(opts));
electron.ipcRenderer.on("use_attribute_under_cursor", (event, opts) => use_attribute_under_cursor(opts));
electron.ipcRenderer.on("default_color", (event, opts) => default_color(opts));
electron.ipcRenderer.on("switch_foreground_background", (event, opts) => switch_foreground_background(opts));
electron.ipcRenderer.on("open_reference_image", (event, opts) => open_reference_image(opts));
electron.ipcRenderer.on("clear_reference_image", (event, opts) => clear_reference_image(opts));
electron.ipcRenderer.on("zoom_in", (event, opts) => zoom_in(opts));
electron.ipcRenderer.on("zoom_out", (event, opts) => zoom_out(opts));
electron.ipcRenderer.on("actual_size", (event, opts) => actual_size(opts));
electron.ipcRenderer.on("f_key", (event, opts) => f_key(opts));
electron.ipcRenderer.on("place", (event, opts) => place(opts));
electron.ipcRenderer.on("get_canvas_size", (event, opts) => get_canvas_size(opts));
electron.ipcRenderer.on("set_canvas_size", (event, opts) => set_canvas_size(opts));
electron.ipcRenderer.on("get_sauce_info", (event, opts) => get_sauce_info(opts));
electron.ipcRenderer.on("set_sauce_info", (event, opts) => set_sauce_info(opts));
electron.ipcRenderer.on("new_document", (event, opts) => new_document(opts));
electron.ipcRenderer.on("change_to_select_mode", (event, opts) => change_to_select_mode(opts));
electron.ipcRenderer.on("change_to_brush_mode", (event, opts) => change_to_brush_mode(opts));

document.addEventListener("DOMContentLoaded", (event) => {
    document.getElementById("ice_colors_toggle").addEventListener("mousedown", (event) => ice_colors(!doc.ice_colors), true);
    document.getElementById("use_9px_font_toggle").addEventListener("mousedown", (event) => use_9px_font(!doc.use_9px_font), true);
    document.getElementById("dimensions").addEventListener("mousedown", (event) => get_canvas_size(), true);
    const canvas_container = document.getElementById("canvas_container");
    canvas_container.addEventListener("mousedown", mouse_down, true);
    canvas_container.addEventListener("mousemove", mouse_move, true);
    canvas_container.addEventListener("mouseup", mouse_up, true);
    canvas_container.addEventListener("mouseout", mouse_up, true);
    document.getElementById("select_mode").addEventListener("mousedown", (event) => change_to_select_mode(), true);
    document.getElementById("brush_mode").addEventListener("mousedown", (event) => change_to_brush_mode(), true);
    document.getElementById("sample_mode").addEventListener("mousedown", (event) => change_to_sample_mode(), true);
}, true);