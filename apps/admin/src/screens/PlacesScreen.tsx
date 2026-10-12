import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { PLACE_CATEGORIES, PLACE_CATEGORY_LABELS, PLACES_ATTRIBUTION, SERVICE_AREA_POLYGON, isInServiceArea } from "@rida/shared";
import { ApiError, createPlace, getPlaces, updatePlace, type AdminPlace, type PlaceCategory } from "../api";
import { useAuth, useToken } from "../auth";

const CAMPUS_CENTRE: L.LatLngTuple = [5.6505, -0.1865];

/** A dot for every place; the selected one is a draggable pin. Plain divIcons: no image files to bundle. */
const dotIcon = (active: boolean) =>
  L.divIcon({ className: active ? "place-dot" : "place-dot inactive", iconSize: [10, 10] });
const pinIcon = L.divIcon({ className: "place-pin", iconSize: [22, 22], iconAnchor: [11, 22] });

interface Draft {
  /** null while adding a new place. */
  id: string | null;
  name: string;
  aliases: string;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  isActive: boolean;
}

function draftOf(p: AdminPlace): Draft {
  return {
    id: p.id,
    name: p.name,
    aliases: p.aliases.join(", "),
    category: p.category,
    latitude: p.latitude,
    longitude: p.longitude,
    isActive: p.isActive,
  };
}

/**
 * Campus places: search, add, rename, move (drag the pin) and deactivate.
 * Every save is audit-logged by the server. Places are never deleted — a
 * deactivated place disappears from riders' search but stays in history.
 */
export function PlacesScreen() {
  const token = useToken();
  const { signOut } = useAuth();
  const [places, setPlaces] = useState<AdminPlace[]>([]);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const dots = useRef<L.LayerGroup | null>(null);
  const pin = useRef<L.Marker | null>(null);

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        signOut();
        return;
      }
      setError(err instanceof ApiError ? err.message : fallback);
    },
    [signOut],
  );

  const load = useCallback(
    async (q: string) => {
      try {
        setPlaces((await getPlaces(token, q)).places);
      } catch (err) {
        fail(err, "Could not load places");
      }
    },
    [token, fail],
  );

  // Search as the admin types, lightly debounced.
  useEffect(() => {
    const t = setTimeout(() => void load(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query, load]);

  const shown = useMemo(() => places.filter((p) => showInactive || p.isActive), [places, showInactive]);

  // The map, once.
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView(CAMPUS_CENTRE, 15);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: `${PLACES_ATTRIBUTION}`,
    }).addTo(m);
    L.polygon(SERVICE_AREA_POLYGON.map(([lat, lng]) => [lat, lng] as L.LatLngTuple), {
      color: "#1f6feb",
      weight: 2,
      fill: false,
      dashArray: "6 6",
    }).addTo(m);
    dots.current = L.layerGroup().addTo(m);
    // While adding, a click puts the new place there.
    m.on("click", (e: L.LeafletMouseEvent) => {
      setDraft((d) => (d && d.id === null ? { ...d, latitude: e.latlng.lat, longitude: e.latlng.lng } : d));
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // A dot per place (click to edit).
  useEffect(() => {
    const group = dots.current;
    if (!group) return;
    group.clearLayers();
    for (const p of shown) {
      L.marker([p.latitude, p.longitude], { icon: dotIcon(p.isActive), title: p.name })
        .on("click", () => setDraft(draftOf(p)))
        .addTo(group);
    }
  }, [shown]);

  // The draggable pin for the place being edited.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!draft) {
      pin.current?.remove();
      pin.current = null;
      return;
    }
    const at: L.LatLngTuple = [draft.latitude, draft.longitude];
    if (!pin.current) {
      pin.current = L.marker(at, { icon: pinIcon, draggable: true, zIndexOffset: 1000 })
        .on("dragend", () => {
          const ll = pin.current!.getLatLng();
          setDraft((d) => (d ? { ...d, latitude: ll.lat, longitude: ll.lng } : d));
        })
        .addTo(m);
    } else {
      pin.current.setLatLng(at);
    }
  }, [draft]);

  const focus = (p: AdminPlace) => {
    setDraft(draftOf(p));
    setNotice(null);
    setError(null);
    map.current?.setView([p.latitude, p.longitude], Math.max(map.current.getZoom(), 17));
  };

  const startAdding = () => {
    const centre = map.current?.getCenter() ?? L.latLng(CAMPUS_CENTRE);
    setDraft({ id: null, name: "", aliases: "", category: "LANDMARK", latitude: centre.lat, longitude: centre.lng, isActive: true });
    setNotice("Click the map (or drag the pin) to where the new place is.");
    setError(null);
  };

  const inArea = draft ? isInServiceArea(draft) : true;

  const save = async (patch: Partial<Draft> = {}) => {
    if (!draft) return;
    const d = { ...draft, ...patch };
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: d.name,
        aliases: d.aliases.split(",").map((a) => a.trim()).filter(Boolean),
        category: d.category,
        latitude: Number(d.latitude.toFixed(6)),
        longitude: Number(d.longitude.toFixed(6)),
        isActive: d.isActive,
      };
      const { place } = d.id ? await updatePlace(token, d.id, body) : await createPlace(token, body);
      setPlaces((list) => [place, ...list.filter((p) => p.id !== place.id)].sort((a, b) => a.name.localeCompare(b.name)));
      setDraft(draftOf(place));
      setNotice(d.id ? `Saved ${place.name} (zone: ${place.zone.name}).` : `Added ${place.name} (zone: ${place.zone.name}).`);
    } catch (err) {
      fail(err, "Could not save the place");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="section-head">
        <h2>Places</h2>
        <button type="button" onClick={startAdding}>
          Add place
        </button>
      </div>

      <div className="places-layout">
        <div className="places-list card">
          <input
            type="search"
            placeholder="Search places (typos are fine)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="inline">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show
            deactivated
          </label>
          <p className="muted small">
            {shown.length} {shown.length === 1 ? "place" : "places"}
          </p>
          <ul>
            {shown.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`place-row${draft?.id === p.id ? " selected" : ""}${p.isActive ? "" : " inactive"}`}
                  onClick={() => focus(p)}
                >
                  <span>{p.name}</span>
                  <span className="muted small">
                    {PLACE_CATEGORY_LABELS[p.category]} · {p.zone.name}
                    {p.isActive ? "" : " · deactivated"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="places-map-col">
          <div ref={mapEl} className="places-map" />

          {draft ? (
            <form
              className="card place-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <h3>{draft.id ? "Edit place" : "New place"}</h3>
              <label htmlFor="place-name">Name</label>
              <input id="place-name" value={draft.name} maxLength={120} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <label htmlFor="place-aliases">Also known as (comma-separated)</label>
              <input
                id="place-aliases"
                value={draft.aliases}
                placeholder="e.g. Balme, Main Library"
                onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
              />
              <label htmlFor="place-category">Category</label>
              <select
                id="place-category"
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value as PlaceCategory })}
              >
                {PLACE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {PLACE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
              <p className="muted small">
                Position {draft.latitude.toFixed(6)}, {draft.longitude.toFixed(6)} — drag the pin to move it.
              </p>
              {!inArea ? <p className="error">That spot is outside the CampusRide service area (dashed line).</p> : null}
              {error ? <p className="error">{error}</p> : null}
              {notice ? <p className="muted">{notice}</p> : null}
              <div className="driver-actions">
                <button type="submit" disabled={saving || !inArea || !draft.name.trim()}>
                  {saving ? "Saving…" : draft.id ? "Save" : "Add place"}
                </button>
                {draft.id ? (
                  <button
                    type="button"
                    className={draft.isActive ? "danger" : "secondary"}
                    disabled={saving}
                    onClick={() => void save({ isActive: !draft.isActive })}
                  >
                    {draft.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                ) : null}
                <button type="button" className="secondary" onClick={() => setDraft(null)}>
                  Close
                </button>
              </div>
            </form>
          ) : (
            <p className="muted small">Pick a place from the list or the map to edit it.</p>
          )}
          <p className="muted small">Place data {PLACES_ATTRIBUTION}.</p>
        </div>
      </div>
    </section>
  );
}
