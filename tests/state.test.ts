import * as fs from "fs";
import * as path from "path";
import {
  StateManager,
  StateError,
  createInitialState,
  loadState,
  saveState,
  isValidTransition,
  transitionPhase,
  setBlocked,
  clearBlocked,
  setCurrentAgent,
  addDevSession,
  updateDevSession,
  removeDevSession,
  getDevSession,
  getDevSessionsByStatus,
} from "../src/state";
import { State, Phase, ORCHESTRATOR_DIR, STATE_FILE } from "../src/types";

// Test directory for isolation
const TEST_DIR = path.join(__dirname, ".test-orchestrator");
const TEST_STATE_FILE = path.join(TEST_DIR, "state.json");

// Mock the constants to use test directory
jest.mock("../src/types", () => {
  const originalModule = jest.requireActual("../src/types");
  const testDir = require("path").join(__dirname, ".test-orchestrator");
  return {
    ...originalModule,
    ORCHESTRATOR_DIR: testDir,
    STATE_FILE: require("path").join(testDir, "state.json"),
  };
});

describe("State Module", () => {
  beforeEach(() => {
    // Clean up test directory before each test
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    // Clean up test directory after all tests
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("createInitialState", () => {
    it("should create a valid initial state", () => {
      const state = createInitialState();

      expect(state.phase).toBe("init");
      expect(state.blocked.isBlocked).toBe(false);
      expect(state.blocked.blockedAgent).toBeNull();
      expect(state.blocked.questionFile).toBeNull();
      expect(state.blocked.waitingFor).toBeNull();
      expect(state.devSessions).toEqual([]);
      expect(state.currentAgent).toBeNull();
      expect(state.lastUpdated).toBeDefined();
    });

    it("should have a valid ISO timestamp", () => {
      const state = createInitialState();
      const date = new Date(state.lastUpdated);
      expect(date.toISOString()).toBe(state.lastUpdated);
    });
  });

  describe("loadState", () => {
    it("should return null when state file does not exist", () => {
      const state = loadState();
      expect(state).toBeNull();
    });

    it("should load state from file", () => {
      const mockState: State = {
        phase: "po_conversation",
        blocked: {
          isBlocked: false,
          blockedAgent: null,
          questionFile: null,
          waitingFor: null,
        },
        devSessions: [],
        currentAgent: "po",
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(mockState, null, 2));

      const loadedState = loadState();
      expect(loadedState).toEqual(mockState);
    });
  });

  describe("saveState", () => {
    it("should save state to file", () => {
      const state = createInitialState();
      saveState(state);

      expect(fs.existsSync(TEST_STATE_FILE)).toBe(true);

      const content = fs.readFileSync(TEST_STATE_FILE, "utf-8");
      const savedState = JSON.parse(content);
      expect(savedState.phase).toBe("init");
    });

    it("should update lastUpdated timestamp on save", () => {
      const state = createInitialState();
      const originalTimestamp = state.lastUpdated;

      // Wait a bit to ensure different timestamp
      const delay = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      return delay(10).then(() => {
        saveState(state);

        const content = fs.readFileSync(TEST_STATE_FILE, "utf-8");
        const savedState = JSON.parse(content);

        expect(new Date(savedState.lastUpdated).getTime()).toBeGreaterThanOrEqual(
          new Date(originalTimestamp).getTime()
        );
      });
    });

    it("should create directory if it does not exist", () => {
      fs.rmSync(TEST_DIR, { recursive: true });

      const state = createInitialState();
      saveState(state);

      expect(fs.existsSync(TEST_DIR)).toBe(true);
      expect(fs.existsSync(TEST_STATE_FILE)).toBe(true);
    });

    it("should use atomic write (no temp files left behind)", () => {
      const state = createInitialState();
      saveState(state);

      const files = fs.readdirSync(TEST_DIR);
      const tempFiles = files.filter((f) => f.includes(".tmp."));
      expect(tempFiles).toHaveLength(0);
    });
  });

  describe("isValidTransition", () => {
    it("should allow init -> po_conversation", () => {
      expect(isValidTransition("init", "po_conversation")).toBe(true);
    });

    it("should allow po_conversation -> tech_lead_design", () => {
      expect(isValidTransition("po_conversation", "tech_lead_design")).toBe(true);
    });

    it("should allow tech_lead_design -> dev_sessions", () => {
      expect(isValidTransition("tech_lead_design", "dev_sessions")).toBe(true);
    });

    it("should allow dev_sessions -> completed", () => {
      expect(isValidTransition("dev_sessions", "completed")).toBe(true);
    });

    it("should not allow skipping phases", () => {
      expect(isValidTransition("init", "tech_lead_design")).toBe(false);
      expect(isValidTransition("init", "dev_sessions")).toBe(false);
      expect(isValidTransition("init", "completed")).toBe(false);
    });

    it("should not allow going backwards", () => {
      expect(isValidTransition("po_conversation", "init")).toBe(false);
      expect(isValidTransition("completed", "init")).toBe(false);
    });

    it("should not allow transitions from completed", () => {
      expect(isValidTransition("completed", "init")).toBe(false);
      expect(isValidTransition("completed", "po_conversation")).toBe(false);
    });
  });

  describe("transitionPhase", () => {
    it("should transition to valid next phase", () => {
      const state = createInitialState();
      const newState = transitionPhase(state, "po_conversation");

      expect(newState.phase).toBe("po_conversation");
    });

    it("should throw StateError for invalid transition", () => {
      const state = createInitialState();

      expect(() => transitionPhase(state, "completed")).toThrow(StateError);
      expect(() => transitionPhase(state, "completed")).toThrow(
        /Invalid phase transition/
      );
    });

    it("should not mutate original state", () => {
      const state = createInitialState();
      const originalPhase = state.phase;

      transitionPhase(state, "po_conversation");

      expect(state.phase).toBe(originalPhase);
    });
  });

  describe("setBlocked / clearBlocked", () => {
    it("should set blocked state", () => {
      const state = createInitialState();
      const newState = setBlocked(state, "dev", "questions/q-001.md", "tech_lead");

      expect(newState.blocked.isBlocked).toBe(true);
      expect(newState.blocked.blockedAgent).toBe("dev");
      expect(newState.blocked.questionFile).toBe("questions/q-001.md");
      expect(newState.blocked.waitingFor).toBe("tech_lead");
    });

    it("should clear blocked state", () => {
      const state = setBlocked(
        createInitialState(),
        "dev",
        "questions/q-001.md",
        "tech_lead"
      );
      const clearedState = clearBlocked(state);

      expect(clearedState.blocked.isBlocked).toBe(false);
      expect(clearedState.blocked.blockedAgent).toBeNull();
      expect(clearedState.blocked.questionFile).toBeNull();
      expect(clearedState.blocked.waitingFor).toBeNull();
    });

    it("should not mutate original state", () => {
      const state = createInitialState();
      setBlocked(state, "dev", "questions/q-001.md", "tech_lead");

      expect(state.blocked.isBlocked).toBe(false);
    });
  });

  describe("setCurrentAgent", () => {
    it("should set current agent", () => {
      const state = createInitialState();
      const newState = setCurrentAgent(state, "po");

      expect(newState.currentAgent).toBe("po");
    });

    it("should clear current agent when set to null", () => {
      const state = setCurrentAgent(createInitialState(), "po");
      const newState = setCurrentAgent(state, null);

      expect(newState.currentAgent).toBeNull();
    });
  });

  describe("DevSession CRUD", () => {
    describe("addDevSession", () => {
      it("should add a new dev session", () => {
        const state = createInitialState();
        const newState = addDevSession(state, "frontend", [1, 2, 3]);

        expect(newState.devSessions).toHaveLength(1);
        expect(newState.devSessions[0]).toEqual({
          area: "frontend",
          tickets: [1, 2, 3],
          status: "pending",
        });
      });

      it("should throw if session already exists", () => {
        let state = createInitialState();
        state = addDevSession(state, "frontend", [1, 2, 3]);

        expect(() => addDevSession(state, "frontend", [4, 5])).toThrow(
          StateError
        );
        expect(() => addDevSession(state, "frontend", [4, 5])).toThrow(
          /already exists/
        );
      });

      it("should allow multiple sessions with different areas", () => {
        let state = createInitialState();
        state = addDevSession(state, "frontend", [1, 2]);
        state = addDevSession(state, "backend", [3, 4]);

        expect(state.devSessions).toHaveLength(2);
      });
    });

    describe("updateDevSession", () => {
      it("should update session status", () => {
        let state = createInitialState();
        state = addDevSession(state, "frontend", [1, 2, 3]);
        state = updateDevSession(state, "frontend", { status: "running" });

        expect(state.devSessions[0].status).toBe("running");
      });

      it("should update session tickets", () => {
        let state = createInitialState();
        state = addDevSession(state, "frontend", [1, 2, 3]);
        state = updateDevSession(state, "frontend", { tickets: [1, 2, 3, 4] });

        expect(state.devSessions[0].tickets).toEqual([1, 2, 3, 4]);
      });

      it("should throw if session not found", () => {
        const state = createInitialState();

        expect(() =>
          updateDevSession(state, "frontend", { status: "running" })
        ).toThrow(StateError);
        expect(() =>
          updateDevSession(state, "frontend", { status: "running" })
        ).toThrow(/not found/);
      });
    });

    describe("removeDevSession", () => {
      it("should remove a dev session", () => {
        let state = createInitialState();
        state = addDevSession(state, "frontend", [1, 2, 3]);
        state = removeDevSession(state, "frontend");

        expect(state.devSessions).toHaveLength(0);
      });

      it("should throw if session not found", () => {
        const state = createInitialState();

        expect(() => removeDevSession(state, "frontend")).toThrow(StateError);
        expect(() => removeDevSession(state, "frontend")).toThrow(/not found/);
      });
    });

    describe("getDevSession", () => {
      it("should get a dev session by area", () => {
        let state = createInitialState();
        state = addDevSession(state, "frontend", [1, 2, 3]);

        const session = getDevSession(state, "frontend");
        expect(session?.area).toBe("frontend");
      });

      it("should return null if session not found", () => {
        const state = createInitialState();
        const session = getDevSession(state, "frontend");

        expect(session).toBeNull();
      });
    });

    describe("getDevSessionsByStatus", () => {
      it("should get all sessions with a specific status", () => {
        let state = createInitialState();
        state = addDevSession(state, "frontend", [1, 2]);
        state = addDevSession(state, "backend", [3, 4]);
        state = updateDevSession(state, "frontend", { status: "running" });

        const runningSessions = getDevSessionsByStatus(state, "running");
        const pendingSessions = getDevSessionsByStatus(state, "pending");

        expect(runningSessions).toHaveLength(1);
        expect(runningSessions[0].area).toBe("frontend");
        expect(pendingSessions).toHaveLength(1);
        expect(pendingSessions[0].area).toBe("backend");
      });
    });
  });

  describe("StateManager", () => {
    it("should initialize with default state", () => {
      const manager = new StateManager();
      const state = manager.getState();

      expect(state.phase).toBe("init");
    });

    it("should initialize with provided state", () => {
      const customState = createInitialState();
      customState.phase = "po_conversation" as Phase;

      const manager = new StateManager(customState);
      expect(manager.getPhase()).toBe("po_conversation");
    });

    it("should persist state on transition", () => {
      const manager = new StateManager();
      manager.transitionTo("po_conversation");

      const loadedState = loadState();
      expect(loadedState?.phase).toBe("po_conversation");
    });

    it("should manage blocked state", () => {
      const manager = new StateManager();

      expect(manager.isBlocked()).toBe(false);

      manager.setBlocked("dev", "questions/q-001.md", "tech_lead");
      expect(manager.isBlocked()).toBe(true);

      manager.clearBlocked();
      expect(manager.isBlocked()).toBe(false);
    });

    it("should manage dev sessions", () => {
      const manager = new StateManager();

      manager.addDevSession("frontend", [1, 2, 3]);
      expect(manager.getDevSession("frontend")?.tickets).toEqual([1, 2, 3]);

      manager.updateDevSession("frontend", { status: "running" });
      expect(manager.getDevSession("frontend")?.status).toBe("running");

      const runningSessions = manager.getDevSessionsByStatus("running");
      expect(runningSessions).toHaveLength(1);

      manager.removeDevSession("frontend");
      expect(manager.getDevSession("frontend")).toBeNull();
    });

    it("should check completion status", () => {
      const completedState = createInitialState();
      // Manually set phase for test (bypass transition validation)
      (completedState as any).phase = "completed";

      const manager = new StateManager(completedState);
      expect(manager.isComplete()).toBe(true);
    });

    it("should set and get current agent", () => {
      const manager = new StateManager();

      manager.setCurrentAgent("po");
      expect(manager.getState().currentAgent).toBe("po");

      manager.setCurrentAgent(null);
      expect(manager.getState().currentAgent).toBeNull();
    });
  });
});
