import { useCallback, useMemo, useState } from "react";
import type { TodoColorId, RecurrenceType } from "@/types/todo";
import type { Locale } from "@/i18n";
import { t } from "@/i18n";
import { useTodoStore } from "@/stores/todoStore";

interface RecurrencePickerState {
  todoId: string;
  type: RecurrenceType;
}

/**
 * WidgetShell 业务逻辑 hook。
 * 将状态选择、UI 交互逻辑从 WidgetShell 组件中抽取出来。
 */
export function useWidgetActions(locale: Locale) {
  const todos = useTodoStore((s) => s.todos);

  const addTodo = useTodoStore((s) => s.addTodo);
  const updateTodoText = useTodoStore((s) => s.updateTodoText);
  const deleteTodo = useTodoStore((s) => s.deleteTodo);
  const clearCompletedTodos = useTodoStore((s) => s.clearCompletedTodos);
  const togglePinned = useTodoStore((s) => s.togglePinned);
  const toggleCompleted = useTodoStore((s) => s.toggleCompleted);
  const setTodoColor = useTodoStore((s) => s.setTodoColor);
  const setTodoDueDate = useTodoStore((s) => s.setTodoDueDate);
  const setTodoRecurrence = useTodoStore((s) => s.setTodoRecurrence);
  const reorderTodos = useTodoStore((s) => s.reorderTodos);
  const duplicateTodo = useTodoStore((s) => s.duplicateTodo);
  const commitTodoEdit = useTodoStore((s) => s.commitTodoEdit);
  const setSuccess = useTodoStore((s) => s.setSuccess);

  // ── 本地 UI 状态 ──
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dueDatePickerFor, setDueDatePickerFor] = useState<string | null>(null);
  const [recurrencePicker, setRecurrencePicker] = useState<RecurrencePickerState | null>(null);
  const [copyToPickerFor, setCopyToPickerFor] = useState<string | null>(null);

  // ── 派生数据 ──
  const menuTodo = useMemo(
    () => (menu ? todos.find((x) => x.id === menu.id) ?? null : null),
    [menu, todos],
  );

  const completedCount = useMemo(
    () => todos.filter((x) => x.completed).length,
    [todos],
  );

  // ── 操作回调 ──
  const handleAdd = useCallback((dueDate?: number) => {
    const id = addTodo();
    setSelectedId(id);
    setEditingId(id);
    if (dueDate !== undefined && dueDate > 0) {
      setTodoDueDate(id, dueDate);
    }
  }, [addTodo, setTodoDueDate]);

  /**
   * 排序模式：从右键菜单「排序」进入，进去后可上下拖动待办调整顺序。
   * 平时不允许拖动整行 —— 否则会和单击选中 / 双击编辑冲突。
   */
  const [sorting, setSorting] = useState(false);

  const handleStartSort = useCallback(() => {
    setMenu(null);
    setSelectedId(null);
    setEditingId(null);
    setSorting(true);
  }, []);

  const handleEndSort = useCallback(() => setSorting(false), []);

  /**
   * 单击：只选中，不再直接进编辑。
   * 按用户要求改成「双击才进编辑」，否则想选中看看或拖拽排序时很容易误进编辑态。
   */
  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  /** 双击：进入编辑态 */
  const handleStartEdit = useCallback((id: string) => {
    setSelectedId(id);
    setEditingId(id);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    setSelectedId(id);
    setMenu({ id, x: e.clientX, y: e.clientY });
  }, []);

  /**
   * 关闭右键菜单时一并取消选中。
   *
   * 不这么做的话：右键 → 点菜单外面关掉 → 这一行的选中底色会一直留着，
   * 看起来发灰、和别的行不一致（与 handleEndEdit 里对编辑态的处理同一个道理）。
   * 菜单里的各项操作都作用在 menu.id 上，不依赖 selectedId，所以清掉是安全的。
   */
  const handleCloseMenu = useCallback(() => {
    setMenu(null);
    setSelectedId(null);
  }, []);

  const handleEndEdit = useCallback(() => {
    if (editingId) commitTodoEdit(editingId);
    setEditingId(null);
    // 退出编辑后一并取消选中：否则该行会一直保留选中底色（看起来发灰、与其它行不一致）
    setSelectedId(null);
  }, [editingId, commitTodoEdit]);

  const handleClearCompleted = useCallback(() => {
    const sel = selectedId;
    const wasCompleted = sel !== null && todos.some((x) => x.id === sel && x.completed);
    clearCompletedTodos();
    setSuccess(t(locale, "toastClearSuccess"));
    setConfirmClear(false);
    if (wasCompleted) {
      setSelectedId(null);
      setEditingId(null);
    }
  }, [selectedId, todos, clearCompletedTodos, locale, setSuccess]);

  const handleDeleteOne = useCallback(() => {
    if (confirmDeleteId) {
      deleteTodo(confirmDeleteId);
      setSuccess(t(locale, "toastDeleteSuccess"));
      if (selectedId === confirmDeleteId) setSelectedId(null);
    }
    setConfirmDeleteId(null);
    setMenu(null);
  }, [confirmDeleteId, deleteTodo, selectedId, locale, setSuccess]);

  const handleRecurrenceConfirm = useCallback(
    (type: RecurrenceType, config: string, dueDate: number) => {
      if (recurrencePicker) {
        setTodoDueDate(recurrencePicker.todoId, dueDate);
        setTodoRecurrence(recurrencePicker.todoId, true, type, config);
      }
      setRecurrencePicker(null);
      setMenu(null);
    },
    [recurrencePicker, setTodoDueDate, setTodoRecurrence],
  );

  const menuActions = useMemo(
    () => ({
      onPin: () => menuTodo && togglePinned(menuTodo.id),
      onDelete: () => {
        if (menuTodo) {
          setMenu(null);
          setConfirmDeleteId(menuTodo.id);
        }
      },
      onToggleDone: () => menuTodo && toggleCompleted(menuTodo.id),
      onPickColor: (c: TodoColorId) => menuTodo && setTodoColor(menuTodo.id, c),
      onPickDueDate: (ts: number) => menuTodo && setTodoDueDate(menuTodo.id, ts),
      onOpenCustomDueDate: () => {
        if (menuTodo) setDueDatePickerFor(menuTodo.id);
      },
      onClearDueDate: () => menuTodo && setTodoDueDate(menuTodo.id, 0),
      onSetRecurrence: (type: RecurrenceType) => {
        if (!menuTodo) return;
        // 关闭右键菜单，打开循环规则弹窗
        setMenu(null);
        setRecurrencePicker({ todoId: menuTodo.id, type });
      },
      onClearRecurrence: () => {
        if (!menuTodo) return;
        setTodoRecurrence(menuTodo.id, false, "none", "");
        setTodoDueDate(menuTodo.id, 0);
      },
      onCopyTo: () => {
        if (!menuTodo) return;
        setCopyToPickerFor(menuTodo.id);
      },
    }),
    [menuTodo, togglePinned, toggleCompleted, setTodoColor, setTodoDueDate, setTodoRecurrence],
  );

  return {
    // 数据
    todos,
    completedCount,
    menuTodo,
    // UI 状态
    selectedId,
    handleCloseMenu,
    sorting,
    handleStartSort,
    handleEndSort,
    editingId,
    menu,
    confirmClear,
    confirmDeleteId,
    dueDatePickerFor,
    recurrencePicker,
    copyToPickerFor,
    // 设置器
    setMenu,
    setConfirmClear,
    setConfirmDeleteId,
    // 操作
    handleAdd,
    handleSelect,
    handleStartEdit,
    handleContextMenu,
    handleEndEdit,
    handleClearCompleted,
    handleDeleteOne,
    handleDueDateConfirm: (ts: number) => {
      if (dueDatePickerFor && ts > 0) {
        setTodoDueDate(dueDatePickerFor, ts);
      }
      setDueDatePickerFor(null);
    },
    handleDueDateCancel: () => setDueDatePickerFor(null),
    handleRecurrenceConfirm,
    handleRecurrenceCancel: () => setRecurrencePicker(null),
    handleCopyToConfirm: (ts: number) => {
      if (copyToPickerFor && ts > 0) {
        duplicateTodo(copyToPickerFor, ts);
        setSuccess(t(locale, "toastCopySuccess"));
      }
      setCopyToPickerFor(null);
    },
    handleCopyToCancel: () => setCopyToPickerFor(null),
    updateTodoText,
    toggleCompleted,
    reorderTodos,
    menuActions,
  };
}
