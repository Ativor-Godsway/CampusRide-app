/**
 * The driver app's entry. The background location task is defined here,
 * before expo-router loads anything: Android can start the app in the
 * background just to deliver positions (the online foreground service), and
 * then no screen or layout is ever loaded. A task defined only by a module
 * the root layout imports isn't defined in that case, and Expo reports
 * "Task 'campusride-driver-location' not found".
 */
import "./lib/backgroundLocation";
import "expo-router/entry";
