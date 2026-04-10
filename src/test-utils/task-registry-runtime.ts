import {
  type TaskRegistryStore,
  type TaskRegistryStoreSnapshot,
  configureTaskRegistryRuntime,
} from "../tasks/task-registry.store.js";
import type { TaskDeliveryState, TaskRecord } from "../tasks/task-registry.types.js";

function cloneTask(task: TaskRecord): TaskRecord {
  return { ...task };
}

function cloneDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  return {
    ...state,
    ...(state.requesterOrigin ? { requesterOrigin: { ...state.requesterOrigin } } : {}),
  };
}

export function installInMemoryTaskRegistryRuntime(): {
  taskStore: TaskRegistryStore;
} {
  let taskSnapshot: TaskRegistryStoreSnapshot = {
    deliveryStates: new Map<string, TaskDeliveryState>(),
    tasks: new Map<string, TaskRecord>(),
  };

  const taskStore: TaskRegistryStore = {
    deleteDeliveryState: (taskId) => {
      taskSnapshot.deliveryStates.delete(taskId);
    },
    deleteTask: (taskId) => {
      taskSnapshot.tasks.delete(taskId);
    },
    loadSnapshot: () => ({
      deliveryStates: new Map(
        [...taskSnapshot.deliveryStates.entries()].map(([taskId, state]) => [
          taskId,
          cloneDeliveryState(state),
        ]),
      ),
      tasks: new Map(
        [...taskSnapshot.tasks.entries()].map(([taskId, task]) => [taskId, cloneTask(task)]),
      ),
    }),
    saveSnapshot: (snapshot) => {
      taskSnapshot = {
        deliveryStates: new Map(
          [...snapshot.deliveryStates.entries()].map(([taskId, state]) => [
            taskId,
            cloneDeliveryState(state),
          ]),
        ),
        tasks: new Map(
          [...snapshot.tasks.entries()].map(([taskId, task]) => [taskId, cloneTask(task)]),
        ),
      };
    },
    upsertDeliveryState: (state) => {
      taskSnapshot.deliveryStates.set(state.taskId, cloneDeliveryState(state));
    },
    upsertTask: (task) => {
      taskSnapshot.tasks.set(task.taskId, cloneTask(task));
    },
  };

  configureTaskRegistryRuntime({ store: taskStore });
  return { taskStore };
}
