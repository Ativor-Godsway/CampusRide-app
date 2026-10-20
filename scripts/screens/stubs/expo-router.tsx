/**
 * expo-router for the screenshots. A scene is a chain of layouts ending in a
 * screen (the root _layout, then (tabs)/_layout, then the tab). Each `Stack`
 * or `Tabs` renders the next element of the chain, so the real layouts
 * (providers, auth gates, the tab bar's options) run as in the app.
 * Navigation is recorded, not followed: a screenshot is one screen.
 */
import {
  createContext,
  useContext,
  useEffect,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import { INSETS } from "./safe-area-context";

export interface RouteScene {
  /** Root layout first, the screen last. */
  chain: ComponentType[];
  params: Record<string, string>;
  pathname: string;
}

const SceneContext = createContext<RouteScene>({ chain: [], params: {}, pathname: "/" });
const DepthContext = createContext(0);

export function RouterScene({ scene, children }: { scene: RouteScene; children: ReactNode }) {
  return <SceneContext.Provider value={scene}>{children}</SceneContext.Provider>;
}

/** Renders the chain element after this layout's. */
function Next(): ReactElement | null {
  const { chain } = useContext(SceneContext);
  const depth = useContext(DepthContext);
  const Component = chain[depth + 1];
  if (!Component) return null;
  return (
    <DepthContext.Provider value={depth + 1}>
      <Component />
    </DepthContext.Provider>
  );
}

const log =
  (what: string) =>
  (...args: unknown[]) => {
    console.log(
      `[screens] navigation ignored: ${what} ${JSON.stringify(args[0] ?? "")}`.slice(0, 200),
    );
  };

export const router = {
  push: log("push"),
  replace: log("replace"),
  navigate: log("navigate"),
  back: () => undefined,
  dismiss: () => undefined,
  dismissAll: () => undefined,
  dismissTo: log("dismissTo"),
  canGoBack: () => true,
  canDismiss: () => true,
  setParams: () => undefined,
};
export const useRouter = () => router;
export const useLocalSearchParams = () => useContext(SceneContext).params;
export const useGlobalSearchParams = useLocalSearchParams;
export const usePathname = () => useContext(SceneContext).pathname;
export const useSegments = () => useContext(SceneContext).pathname.split("/").filter(Boolean);
export const useIsFocused = () => true;
export const useRootNavigationState = () => ({ key: "root" });
export function useFocusEffect(effect: () => void | (() => void)) {
  useEffect(effect, [effect]);
}
export const useNavigation = () => ({
  setOptions: () => undefined,
  addListener: () => () => undefined,
  removeListener: () => undefined,
  canGoBack: () => true,
  goBack: () => undefined,
  getState: () => ({ routes: [], index: 0 }),
  isFocused: () => true,
});

/** expo-router/react-navigation: leaving a screen is never attempted here. */
export const usePreventRemove = (_prevent: boolean, _callback: unknown) => undefined;

export function Redirect({ href }: { href: unknown }) {
  console.log(
    `[screens] <Redirect> to ${JSON.stringify(href)} (the scene's data probably isn't what this screen expects)`,
  );
  return null;
}

export const SplashScreen = {
  hideAsync: async () => undefined,
  preventAutoHideAsync: async () => undefined,
  hide: () => undefined,
};

function StackComponent(_props: { screenOptions?: unknown; children?: ReactNode }) {
  return <Next />;
}
StackComponent.Screen = (_props: unknown) => null;
export const Stack = StackComponent;
export const Slot = () => <Next />;

interface TabOptions {
  title?: string;
  href?: unknown;
  tabBarIcon?: (p: { color: string; size: number; focused: boolean }) => ReactNode;
}
interface TabScreenProps {
  name: string;
  options?: TabOptions;
}
interface TabsProps {
  screenOptions?: {
    tabBarActiveTintColor?: string;
    tabBarInactiveTintColor?: string;
    tabBarStyle?: object;
    tabBarLabelStyle?: object;
  };
  children?: ReactNode;
}

/** The screen, and a tab bar from the layout's own Tabs.Screen options. */
function TabsComponent({ screenOptions = {}, children }: TabsProps) {
  const { pathname } = useContext(SceneContext);
  const screens = (Array.isArray(children) ? children : [children])
    .flat()
    .filter((c): c is ReactElement<TabScreenProps> =>
      Boolean(c && typeof c === "object" && "props" in c),
    )
    .map((c) => c.props)
    .filter((p) => p.name && p.options?.href !== null);
  const active = pathname.split("/").filter(Boolean)[0] ?? "index";
  const activeTint = screenOptions.tabBarActiveTintColor ?? "#19743C";
  const inactiveTint = screenOptions.tabBarInactiveTintColor ?? "#646D69";
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <Next />
      </View>
      <View
        style={[
          { flexDirection: "row", paddingBottom: INSETS.bottom, paddingTop: 6 },
          screenOptions.tabBarStyle,
        ]}
      >
        {screens.map((s) => {
          const focused = s.name === active || (active === "index" && s.name === "index");
          const color = focused ? activeTint : inactiveTint;
          return (
            <Pressable
              key={s.name}
              style={{ flex: 1, alignItems: "center", gap: 2, paddingTop: 4 }}
            >
              {s.options?.tabBarIcon?.({ color, size: 24, focused })}
              <Text style={[{ color, fontSize: 10 }, screenOptions.tabBarLabelStyle]}>
                {s.options?.title ?? s.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
TabsComponent.Screen = (_props: TabScreenProps) => null;
export const Tabs = TabsComponent;

export const Link = ({ children }: { children?: ReactNode }) => <>{children}</>;
export type Href = string;
