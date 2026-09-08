// Bilingual i18n (Spanish default, English toggle). Wraps i18n-js in a React
// context so switching locale re-renders the whole tree.
import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getPref, initDb, setPref } from '@/lib/db';

// i18n-js pluralization: a translation value may be a flat string, or an
// object with `one`/`other` (and optionally `zero`) branches selected
// automatically from the `count` option passed at call time.
type PluralForm = { one: string; other: string; zero?: string };

const translations = {
  es: {
    common: {
      today: 'Hoy',
      daysAway: 'faltan %{count} días',
      oneDayAway: 'falta 1 día',
      past: 'Finalizada',
      tbd: 'Fecha por confirmar',
      when: 'Cuándo',
      where: 'Dónde',
      distances: 'Distancias',
      organizer: 'Organiza',
      notes: 'Notas',
      route: 'Ruta',
      changed: 'Cambio anunciado',
      canceled: 'Cancelada',
      lastVerified: 'Verificada el',
      more: 'Ver más',
      less: 'Ver menos',
      notFound: 'No encontramos esta carrera',
      back: 'Volver',
      unconfirmed: 'Sin confirmar',
      retry: 'Reintentar',
      cancel: 'Cancelar',
    },
    tabs: {
      track: 'Correr',
      leaderboard: 'Tabla',
      feed: 'Carreras',
      myRaces: 'Guardadas',
      settings: 'Perfil',
    },
    track: {
      newSession: 'Nueva sesión',
      pause: 'Pausar',
      resume: 'Reanudar',
      paused: 'En pausa',
      checkpointFound: 'Tienes una sesión sin terminar. ¿La continuamos o la descartamos?',
      close: 'Cerrar',
      // Session-end map screen (2026-09-02 redesign): the ✓ that closes the
      // just-finished-run map and readies the app for a new session — a
      // distinct action from `close` above (which still closes a plain X),
      // so it gets its own label rather than reusing that string.
      done: 'Listo',
      recenterFence: 'Centrar en el territorio',
      start: 'Iniciar',
      stop: 'Terminar',
      starting: 'Buscando señal…',
      distance: 'Distancia',
      time: 'Tiempo',
      area: 'Área',
      pace: 'Ritmo',
      waiting: 'Esperando tu primera ubicación…',
      // Camera controls during a session (Task D) — accessibility labels
      // for the zoom +/- and re-center buttons in track-map.web.tsx.
      zoomIn: 'Acercar',
      zoomOut: 'Alejar',
      // Camera-mode cycle button (P4): recenter is the label shown while in
      // overview mode (tapping switches to follow); overview is the label
      // shown while in follow mode (tapping switches to overview).
      recenter: 'Centrar en mi ubicación',
      overview: 'Ver todo el recorrido',
      mapUnavailable: 'No pudimos cargar el mapa. Tu recorrido se sigue registrando.',
      permission:
        'Necesitamos permiso de ubicación para trazar tu recorrido. Actívalo en los ajustes de tu teléfono.',
      unavailable: 'No pudimos acceder al GPS en este dispositivo.',
      keepOpen: 'Mantén la pantalla encendida — si bloqueas el teléfono se detiene el registro.',
      keepAwakeFailed:
        'No pudimos mantener la pantalla encendida — evita bloquear el teléfono para no perder el registro.',
      backgroundGap: 'El registro se pausó mientras la app estaba en segundo plano.',
      // Pace guard (pace-guard.ts). Tone matters more here than anywhere
      // else in the app: this fires on a real person mid-session and throws
      // their run away, and it will occasionally be wrong. So it never
      // accuses — it says what was measured, what happened, and how to carry
      // on. No "we know", no "cheating", no blame. Someone genuinely in a
      // car already knows why; someone with a bad GPS fix must not be made
      // to feel caught.
      paceGuardTitle: 'Parece que ya no vas corriendo',
      paceGuardBody:
        'Llevas medio minuto moviéndote más rápido de lo que se puede correr, así que terminamos la sesión. No guardamos nada: el territorio solo cuenta si lo recorres a pie.',
      paceGuardDismiss: 'Entendido',
      // Distance-gap instrumentation on the finished-run summary — see
      // tracking.ts's gapCount/gapDurationMs/gapChordM/creditedGapM.
      // %{duration}/%{credited}/%{uncredited} are pre-formatted strings from
      // formatDuration/formatDistance. Split (not one bare %{chord}) since
      // gap-distance-policy: the credited part IS already inside the
      // Distance stat shown a few lines above this notice, so saying so
      // avoids a runner double-adding it back on top.
      gapNotice: {
        one: '1 interrupción por segundo plano (%{duration}) — ~%{credited} contados en línea recta, ~%{uncredited} sin registrar.',
        other: '%{count} interrupciones por segundo plano (%{duration}) — ~%{credited} contados en línea recta, ~%{uncredited} sin registrar.',
      } as PluralForm,
      searching: 'Buscando señal GPS…',
      accuracy: 'Precisión: %{m} m',
      weakSignal: 'Señal débil — muévete a cielo abierto para empezar a trazar.',
      degradedSignal: 'Señal débil — seguimos trazando, con menos precisión.',
      summaryTitle: 'Territorio conquistado',
      noFence:
        'Tu recorrido fue muy corto para formar un área. Corre un circuito y vuelve a intentarlo.',
      save: 'Guardar territorio',
      saving: 'Guardando…',
      saved: 'Territorio guardado',
      discard: 'Descartar',
      // Task 2 — auto-save means there is usually already a server row by
      // the time the summary renders, so "Descartar" (which never touched
      // the server) stopped being honest. deleteRun() actually removes that
      // row; these keys are for that flow specifically, distinct from
      // `discard` above (still used by the unfinished-checkpoint recovery
      // prompt, which never reaches the server at all).
      deleteRun: 'Eliminar territorio',
      deleting: 'Eliminando…',
      // Shown once, inline, before the delete actually happens — see
      // apply_territory_overlap() in 20260827020000_phase3_overlap.sql:
      // ground this run took from other runners during the overlap was
      // already carved out of their fences at save time, and nothing reads
      // territory_events back to reverse that. Saying "elimina tu
      // territorio" without this line would imply a clean undo that does
      // not exist.
      deleteConfirmBody:
        'Esto borra tu registro y este territorio. El terreno que ya le quitaste a otros corredores durante esta sesión no se les devuelve.',
      deleteConfirmAction: 'Eliminar de todas formas',
      deleteFailedNetwork:
        'No pudimos eliminar tu territorio — revisa tu conexión. Sigue guardado, puedes reintentar.',
      deleteFailedAuth: 'No pudimos confirmar tu sesión para eliminarlo. Vuelve a intentarlo.',
      deleteFailedDisabled:
        'El guardado en línea no está disponible en esta versión, así que no podemos eliminarlo desde aquí.',
      // Distinct from deleteFailedNetwork on purpose: this isn't a
      // connection problem, and "revisa tu conexión" would send the runner
      // chasing a WiFi bar that was never the issue. Reintentar won't help
      // here — see deleteRun()'s 'denied' reason.
      deleteFailedDenied:
        'Todavía no podemos eliminar territorios desde aquí — esa función está en camino. Sigue guardado.',
      syncFailedNetwork:
        'No pudimos guardar tu territorio — revisa tu conexión. Tu recorrido sigue aquí, puedes reintentar.',
      syncFailedAuth: 'No pudimos crear tu sesión. Vuelve a intentarlo.',
      // Distinct from syncFailedNetwork: this run was retried until the
      // queue gave up on it (see upload-queue.ts's MAX_ATTEMPTS) — it is
      // genuinely gone, not just waiting on a signal.
      syncFailedAbandoned:
        'No pudimos guardar tu territorio después de varios intentos y no sigue en la fila. Se perdió.',
      // NOT the same string as leaderboard.disabled below, even though it
      // used to read identically — that one genuinely has nothing to queue
      // (there's no leaderboard entry to save for later). This one now
      // does: 'disabled' saves are queued the same as a network failure
      // (index.tsx), so the copy can't imply this is the end of it — the
      // queued banner shows right alongside this one, and together they
      // need to read as "not yet, but safe and will retry" not "give up".
      syncDisabled: 'El guardado en línea no está disponible en esta versión por ahora.',
      retry: 'Reintentar',
      pastFencesFailed: 'No pudimos cargar tus territorios anteriores.',
      allInsideZone:
        'Toda tu sesión ocurrió dentro de tu zona privada, así que no podemos guardarla sin revelar dónde vives. Aléjate un poco antes de empezar.',
      zoneMasked:
        'Recortamos el inicio y el final de tu recorrido por tu zona privada. Lo que ves aquí es lo que se sube.',
      queued:
        'Guardamos tu sesión en el teléfono. La subiremos sola la próxima vez que abras la app con señal — ya no se pierde si cierras.',
      pendingUploads: {
        one: '1 sesión guardada en el teléfono, pendiente de subir.',
        other: '%{count} sesiones guardadas en el teléfono, pendientes de subir.',
      } as PluralForm,
      // tookArea/tookFrom above are UNCHANGED and stay unused-but-present
      // (Tile Coverage brief §4: don't delete anything this pass) — the
      // enclosure model's Phase 3 could actually TAKE ground via
      // ST_Difference; first-to-claim tiles never can (no decay yet), so
      // "took" would be a false claim under the new model. crossedTiles/
      // crossedFrom below say the true, weaker thing: tiles this run ran
      // over but could not claim because someone already held them.
      crossedTiles: {
        one: 'Cruzaste 1 casilla ya tomada',
        other: 'Cruzaste %{count} casillas ya tomadas',
      } as PluralForm,
      crossedFrom: {
        one: 'de 1 corredor',
        other: 'de %{count} corredores',
      } as PluralForm,
      // Stat-bar label replacing `area` (still defined above, unused by the
      // session-end screen now — see index.tsx) — brief §6 step 5.
      tiles: 'Casillas',
      // Running total, best-effort (fetchMyTileTotal) — the honest stand-in
      // for the brief §1.5 "% of San Pedro stomped" headline, which needs
      // §1's real municipio/runnable-tile denominator (explicitly out of
      // scope this pass). A raw count against "everyone who's played so
      // far", not against the true reachable area — see index.tsx and the
      // executor's report for why a fabricated-denominator percentage would
      // be exactly the mistake the brief §1 warns against.
      tilesHeld: 'Ahora tienes %{count} casillas en %{region}.',
      // Shown instead of a tile count when claimTiles() didn't complete
      // (network hiccup, or the §2.5 forgery guard rejected the batch) —
      // the run itself is still saved either way; see uploadRun's own doc
      // comment. Never silently shows "0 casillas" as if that were the true
      // result — see this repo's standing rule against unverified success.
      tilesUnavailable: 'No pudimos confirmar tus casillas esta vez — tu recorrido sigue guardado.',
      // The "joining" half of the brief §6 step 5 transition: the enclosure
      // area still gets computed and stored every upload (buildFence isn't
      // deleted — brief §4), shown here small and explicitly labelled as
      // no-longer-authoritative, so a suspicious run can be sanity-checked
      // against the old model on the very screen that used to trust it
      // (this whole brief exists because a 3.3km run once auto-closed into
      // 977,565 m² here). Never the headline number again.
      legacyArea: 'Modelo anterior: %{area} (ya no cuenta para tu territorio)',
    },
    leaderboard: {
      title: 'Tabla de posiciones',
      soonTitle: 'Muy pronto',
      soonBody:
        'Aquí verás quién tiene más territorio. Por ahora corre y acumula el tuyo — se contará cuando abramos la tabla.',
      global: 'Global',
      anonymous: 'Anónimo',
      // runs/flagged above are UNCHANGED (brief §4: don't delete) but no
      // longer rendered — the tile-count board (tiles/flaggedTiles below)
      // replaced them; see leaderboard.tsx.
      runs: {
        one: '1 sesión',
        other: '%{count} sesiones',
      } as PluralForm,
      flagged: {
        one: '1 sesión marcada',
        other: '%{count} sesiones marcadas',
      } as PluralForm,
      tiles: {
        one: '1 casilla',
        other: '%{count} casillas',
      } as PluralForm,
      flaggedTiles: {
        one: '1 casilla de sesión marcada',
        other: '%{count} casillas de sesiones marcadas',
      } as PluralForm,
      empty: 'Nadie ha conquistado territorio todavía.\nSé el primero.',
      emptyRegion:
        'Nadie ha conquistado territorio en %{city} todavía.\nSé el primero — o mira la tabla global.',
      error: 'No pudimos cargar la tabla. Revisa tu conexión.',
      disabled: 'El guardado en línea no está configurado en esta versión.',
    },
    feed: {
      title: 'Carreras',
      search: 'Buscar carrera o ciudad…',
      empty: 'No se encontraron carreras.',
      otherCities: {
        one: '1 carrera en otra ciudad',
        other: '%{count} carreras en otras ciudades',
      } as PluralForm,
      updated: 'Datos actualizados',
      updateFailed: 'No pudimos actualizar los datos',
      thisWeek: 'Esta semana',
      nextRace: 'Próxima carrera',
      walksShelf: 'Caminatas',
      regOpen: 'Registro abierto',
    },
    filters: {
      '3K': '3K',
      '5K': '5K',
      '10K': '10K',
      '15K': '15K',
      half: '21K',
      '30K': '30K',
      full: '42K',
      ultra: 'Ultra',
      tbd: 'Por confirmar',
      title: 'Filtros',
      distance: 'Distancia',
      date: 'Fecha',
      reset: 'Limpiar',
      clearAll: 'Limpiar todo',
      done: 'Listo',
      presetThisMonth: 'Este mes',
      presetNext3: 'Próximos 3 meses',
      presetAll: 'Todos',
    },
    detail: {
      buy: 'Comprar boleto',
      noLink: 'Registro próximamente',
      canceled: 'Carrera cancelada',
      viewRegistration: 'Ver registro',
      save: 'Guardar',
      saved: 'Guardada',
      saveFailed: 'No pudimos guardar la carrera en este dispositivo. Vuelve a intentarlo.',
      addCalendar: 'Agregar al calendario',
      calendarAdded: 'Agregada a tu calendario',
      calendarAddedNoTime:
        'Agregada a tu calendario como evento de todo el día — el organizador aún no confirma la hora de salida.',
      calendarAlready: 'Esta carrera ya está en tu calendario.',
      calendarFailed: 'No pudimos agregarla a tu calendario. Vuelve a intentarlo.',
      calendarNoDate: 'Esta carrera aún no tiene fecha confirmada.',
      permission: 'Necesitamos permiso para acceder a tu calendario.',
      viewSource: 'Ver fuente',
      close: 'Cerrar',
      openBrowser: 'Abrir en el navegador',
      checkoutFailed:
        'No pudimos abrir el registro aquí. Puede que el enlace ya no funcione o que el organizador no permita abrirlo dentro de la app.',
      checkoutBlocked: '¿No carga? Ábrelo en el navegador',
      openMaps: 'Abrir en Mapas',
      approxLocation: 'Ubicación aproximada del punto de salida',
      share: 'Compartir',
      shareMessage: '%{name} — %{date}',
    },
    myraces: {
      title: 'Mis carreras',
      empty: 'Aún no has guardado carreras.\nExplora y guarda las que te interesen.',
      pastSection: 'Anteriores',
      upcomingSection: 'Próximas',
      storageBlocked:
        'Este navegador no permite guardar datos (por ejemplo, en modo privado), así que tus carreras no se conservarán al cerrar la app.',
      missing: {
        one: '1 carrera guardada ya no está disponible — el organizador la retiró del calendario.',
        other:
          '%{count} carreras guardadas ya no están disponibles — el organizador las retiró del calendario.',
      } as PluralForm,
      clearMissing: 'Quitarlas de mi lista',
      remove: 'Quitar de mis carreras',
      tabRaces: 'Carreras',
      tabFences: 'Territorios',
      fencesEmpty:
        'Aún no has conquistado territorio.\nInicia una sesión en Correr para trazar tu primer cercado.',
      fencesError: 'No pudimos cargar tus territorios. Revisa tu conexión.',
      fencesDisabled: 'El guardado en línea no está configurado en esta versión.',
      fenceFlagged:
        'Marcamos esta sesión: la velocidad no parece de carrera a pie. Sigue contando para tu territorio.',
      fenceLost: 'Perdiste %{area} de este territorio',
      fenceFullyTaken: 'Te quitaron todo este territorio',
      // Territories map detail card (2026-09-02) — a run still in the
      // offline retry queue, drawn in its own dashed/muted state on the
      // map, gets this badge instead of the usual stats-only card.
      pendingLabel: 'Sin subir todavía — se reintentará solo',
    },
    city: {
      title: 'Elige tu ciudad',
      useLocation: 'Usar mi ubicación',
      detectFailed: 'No pudimos detectar tu ubicación — elige tu ciudad manualmente.',
      mxOnly: 'Disponible en México por ahora.',
      emptyRegion: 'Aún no tenemos carreras en %{city}.\nEstamos trabajando en ello — por ahora explora Monterrey.',
      locationOn: 'usando tu ubicación',
    },
    settings: {
      title: 'Ajustes',
      version: 'Versión',
      // Long-press on the version row — see last-run-debug.ts. Not surfaced
      // anywhere a runner would find it by browsing.
      debugCopied: 'Copiamos %{count} puntos al portapapeles.',
      // No finished run to report, but the pilot counters (backgrounding,
      // watch restarts, runs recovered/lost) still copied — see
      // pilot-instrumentation.ts.
      debugCopiedCountersOnly: 'Copiamos los contadores del piloto al portapapeles.',
      // Identity diagnostic (identity-diagnostic.tsx) — deliberately plain
      // and unglamorous copy: this row exists to be read out loud in a
      // support message, not to reassure. "Territorios en el servidor" says
      // exactly what the number is, so it can't be confused with what the
      // map happens to be drawing.
      diagnosticTitle: 'Diagnóstico',
      diagnosticBody:
        'Qué cuenta está usando este dispositivo y qué devuelve el servidor para ella. Útil si tu territorio no aparece.',
      diagnosticSession: 'Sesión',
      diagnosticEmail: 'Correo',
      diagnosticTerritories: 'Territorios en el servidor',
      diagnosticQueued: 'En cola por subir',
      diagnosticNoSession: 'sin sesión',
      diagnosticAnonymous: '— (cuenta anónima)',
      // Never rendered in place of a count: a failed query and a genuine
      // zero must read differently. `reason` is the raw code from
      // territory-sync.ts (disabled/auth/network) — untranslated on purpose,
      // it's the exact token to quote back in a bug report.
      diagnosticFailed: 'la consulta falló (%{reason})',
      diagnosticSkipped: '(%{count} sin poder leerse)',
      diagnosticRecheck: 'Volver a revisar',
      diagnosticChecking: 'Revisando…',
      diagnosticCopy: 'Copiar',
      diagnosticCopied: 'Copiado',
      support: 'Soporte',
      theme: 'Apariencia',
      themeSystem: 'Sistema',
      themeLight: 'Claro',
      themeDark: 'Oscuro',
      language: 'Idioma',
      location: 'Ubicación',
      locationOn: 'Activada',
      locationOff: 'Bloqueada',
      locationNotSet: 'Sin activar',
      locationUnknown: 'Sin verificar',
      locationOnHint:
        'Podemos trazar tus recorridos. Solo se usa mientras la app está abierta y una sesión está en curso.',
      locationOffHint:
        'Sin este permiso no podemos trazar tus recorridos ni conquistar territorio.',
      locationEnable: 'Activar ubicación',
      locationOpenSettings: 'Abrir ajustes del teléfono',
      locationBrowserBlocked: 'Desbloquea la ubicación en tu navegador',
      reminders: 'Recordatorios',
      remindersHint:
        'Te avisamos 3 días antes y la noche anterior de cada carrera que guardes.',
      remindersOnHint:
        'Te avisaremos 3 días antes y la noche anterior de cada carrera que guardes.',
      remindersDenied:
        'No diste permiso para enviarte notificaciones. Actívalo en los ajustes de tu teléfono para usar los recordatorios.',
      privacyZone: 'Zona privada',
      zoneSetHere: 'Usar mi ubicación',
      zoneRemove: 'Quitar',
      zoneSetting: 'Guardando…',
      zoneOnHint:
        'Activada. Recortamos los primeros y últimos %{m} m de cada sesión antes de subirla, con un margen aleatorio para que no se pueda deducir el centro. El punto se queda en este teléfono: nunca se sube.',
      zoneOffHint:
        'Sin zona privada, el inicio y el final exactos de tus sesiones se suben y cualquier persona que use la app puede verlos. Ponla donde vives.',
      zoneFailed: 'No pudimos guardar tu zona. Revisa el permiso de ubicación e inténtalo otra vez.',
      displayName: 'Nombre en la tabla',
      displayNamePlaceholder: 'Anónimo',
      displayNameHint:
        'Es el nombre que ven los demás en la tabla de posiciones, y solo tú puedes tenerlo. Déjalo vacío para aparecer como Anónimo.',
      displayNameSaved: 'Nombre guardado',
      displayNameFailed: 'No pudimos guardar tu nombre. Revisa tu conexión.',
      // Save/discard for an EDIT of a name that already exists. The
      // leaderboard reads profiles(display_name) live on every fetch, so a
      // rename is retroactive: it relabels every entry you already have,
      // not just the ones from here on. Hence an explicit commit instead of
      // the save-on-blur that still handles naming yourself the first time.
      displayNameDirtyHint:
        'Cambiar tu nombre lo actualiza en toda la tabla, también en tus posiciones anteriores.',
      displayNameSave: 'Guardar',
      displayNameDiscard: 'Descartar',
      // Uniqueness: one name field, and it is the identity on a ranked list
      // (see nickname.ts). 'Taken' and 'reserved' are things the runner can
      // fix, so they never collapse into displayNameFailed's "check your
      // connection".
      displayNameTaken: 'Ese nombre ya lo tiene alguien más. Prueba con otro.',
      displayNameReserved: 'Ese nombre está reservado. Elige otro.',
      // Profile section (Settings tab redesign) — the identity concerns
      // grouped at the top of the screen, plus the honest statement of
      // account status the owner asked for.
      sectionProfile: 'Perfil',
      sectionPreferences: 'Preferencias',
      sectionLocation: 'Ubicación y privacidad',
      sectionAbout: 'Acerca de',
      // Settings IA (2026-09-03): the tab is now a list of rows, each pushing
      // its own sub-page (src/app/(tabs)/settings/). The row labels and the
      // stack header titles REUSE the section keys above plus accountTitle
      // and privacy.title — the only new copy is the two list-group headers
      // and the one-line description under each row.
      groupAccount: 'Cuenta',
      groupApp: 'Aplicación',
      navProfileHint: 'Tu nombre en la tabla de posiciones',
      navAccountHint: 'Vincula tu correo para no perder tu territorio',
      navPreferencesHint: 'Apariencia, idioma y recordatorios',
      navLocationHint: 'Permiso de ubicación y tu zona privada',
      navPrivacyHint: 'Qué recopilamos y qué no',
      navAboutHint: 'Versión y soporte',
      accountTitle: 'Tu cuenta',
      accountBody:
        'Este dispositivo tiene una cuenta anónima para guardar tus territorios. Si cambias de navegador, de dispositivo o se borran los datos del sitio, esa cuenta —y el territorio que tenga guardado— deja de aparecer. Agrega tu correo para que tu progreso te siga a donde entres.',
      accountEmailPlaceholder: 'tu@correo.com',
      accountSendCode: 'Enviar código',
      accountSending: 'Enviando…',
      accountEmailInvalid: 'Escribe un correo válido.',
      accountCodeSent: 'Enviamos un código a %{email}. Revisa tu correo.',
      // Delivery is Supabase's email template, configured outside this repo —
      // when it misbehaves the runner just sees nothing arrive. Say where
      // else to look before they conclude the app is broken.
      accountCodeSpam: 'Si no llega en un par de minutos, revisa tu carpeta de spam.',
      accountCodePlaceholder: 'Código de 6 dígitos',
      accountVerify: 'Confirmar',
      accountVerifying: 'Confirmando…',
      accountCodeInvalid: 'Ese código no es válido o ya venció. Inténtalo de nuevo.',
      accountChangeEmail: 'Cambiar correo',
      accountFailed: 'Algo falló. Revisa tu conexión e inténtalo otra vez.',
      // Only the SIGN IN path (account.ts) replaces this device's local
      // identity — shown only when startEmailAuth reports mode:'signin',
      // i.e. the email already belongs to an account linked elsewhere.
      accountSwitchWarning:
        'Ese correo ya tiene una cuenta. Al confirmar, este dispositivo pasará a usarla — cualquier territorio guardado solo aquí dejará de verse.',
      accountLinked: 'Cuenta vinculada: %{email}',
      // Ver la nota en inglés (arriba, en la traducción `en`) — mismo caso,
      // solo el flujo de enlace por correo (no el de código en la app).
      accountLinkedSwapped:
        'Este dispositivo ahora usa la cuenta %{email}. Si tenía territorio guardado solo aquí con otra cuenta, puede que ya no lo veas.',
      // First-save name prompt (name-prompt.tsx) — asked once, at the
      // moment a run is first saved, never on first app open.
      namePromptTitle: '¿Cómo quieres aparecer en la tabla?',
      namePromptBody:
        'Ponle un nombre a tu territorio. Si prefieres no hacerlo, sigues apareciendo como Anónimo.',
      namePromptSave: 'Guardar',
      namePromptSkip: 'Ahora no',
      namePromptSaving: 'Guardando…',
      namePromptFailed:
        'No pudimos guardar tu nombre. Puedes intentarlo de nuevo o dejarlo para después.',
    },
    privacy: {
      title: 'Privacidad',
      collectedTitle: 'Qué recopilamos',
      collectedLocation:
        'Ubicación aproximada: si das permiso de GPS, la usamos solo en este dispositivo para mostrarte carreras cercanas. Nunca sale de tu teléfono.',
      collectedIp:
        'Si el GPS no está disponible o no diste permiso, calculamos tu ciudad aproximada a partir de tu dirección IP con el servicio ipapi.co. Tu IP se envía a ipapi.co en ese momento — es lo único que sale de tu dispositivo, y solo pasa cuando no hay GPS.',
      collectedSaved:
        'Carreras guardadas: los IDs de las carreras que guardas quedan solo en este dispositivo (SQLite en iOS/Android, almacenamiento local en la versión web). No se sincronizan a ningún servidor.',
      collectedReminders:
        'Recordatorios: si los activas, tu teléfono programa las notificaciones localmente. No usamos notificaciones push ni servidores de mensajería — nada sale de tu dispositivo, y al desactivarlos se cancelan todas.',
      collectedTerritory:
        'Territorio: cuando grabas una carrera en la pestaña Correr, el recorrido GPS y el área que encierra sí se guardan en nuestro servidor (Supabase). Esto es necesario para que el juego funcione: sin datos compartidos no hay tabla de posiciones ni territorios que se traslapen. Solo se guarda lo que grabas — abrir la app o ver carreras nunca envía tu ubicación.',
      collectedQueue:
        'Sesiones pendientes: si falla la subida (sin señal), guardamos el recorrido en este teléfono para no perderlo y lo subimos solo cuando vuelva la señal. Se borra en cuanto se sube, o si eliminas la carrera — cerrar la pantalla de resumen no la borra.',
      collectedCheckpoint:
        'Progreso en curso: mientras grabas, guardamos tu recorrido completo (sin recortar por tu zona privada) en este teléfono cada pocos segundos, para no perderlo si la app se cierra sola. Se borra en cuanto guardas o descartas la sesión — el recorte de tu zona privada solo se aplica al guardar.',
      collectedDebug:
        'Diagnóstico técnico: guardamos el recorrido completo (sin recortar) de tu última sesión terminada en este teléfono, para poder revisar problemas de medición si nos avisas de uno. Solo se accede a mano desde Ajustes, y cada sesión nueva reemplaza a la anterior.',
      collectedIdentity:
        'Identidad: al guardar tu primer territorio creamos una cuenta anónima ligada a este dispositivo. No pedimos correo ni contraseña para eso. Si desde Ajustes agregas tu correo para que tu progreso te siga a otro dispositivo, ese correo se guarda junto con tu cuenta — es opcional, nunca se pide para usar la app.',
      collectedZone:
        'Zona privada: puedes marcar dónde vives en Ajustes. Recortamos el inicio y el final de cada sesión antes de subirla, con un margen aleatorio para que no se pueda deducir el centro a partir de varias sesiones. Ese punto se guarda solo en este teléfono y nunca se sube a ningún servidor.',
      collectedVisible:
        'Visible para otros: los territorios que guardas y el nombre que elijas en Ajustes aparecen en la tabla de posiciones para cualquier persona que use la app. El área que conquistaste se ve en el mapa; si no pones un nombre, apareces como Anónimo. Cada carrera que terminas se guarda automáticamente — ya no puedes optar por no guardarla. Si prefieres no aparecer, elimínala después desde la pantalla de resumen o la pestaña Territorios (esto no revierte el terreno que ya le hayas quitado a otros corredores mientras estuvo activa).',
      notTitle: 'Qué no hacemos',
      notAccounts: 'No pedimos correo, contraseña ni datos personales para usar la app.',
      notTracking: 'No rastreamos tu actividad fuera de las carreras que tú grabas, ni usamos analítica.',
      notSharing:
        'No vendemos tus datos ni los compartimos con terceros. Dentro de la app, lo único que ven otros corredores es lo de la tabla de posiciones, arriba.',
      notServer:
        'Fuera del territorio que grabas, nada más se guarda en un servidor: tus carreras guardadas, tu idioma y tus recordatorios viven solo en este dispositivo.',
      deleteTitle: 'Borrar tus datos',
      deleteBody:
        'Lo guardado localmente (carreras guardadas, idioma, recordatorios) se borra al eliminar la app de tu teléfono o los datos del sitio en tu navegador. Para borrar los territorios que subiste, escríbenos desde la sección de soporte y eliminamos tu cuenta anónima y sus recorridos.',
      ipapiLink: 'Política de privacidad de ipapi.co',
    },
  },
  en: {
    common: {
      today: 'Today',
      daysAway: '%{count} days away',
      oneDayAway: '1 day away',
      past: 'Finished',
      tbd: 'Date TBD',
      when: 'When',
      where: 'Where',
      distances: 'Distances',
      organizer: 'Organizer',
      notes: 'Notes',
      route: 'Route',
      changed: 'Change announced',
      canceled: 'Canceled',
      lastVerified: 'Verified on',
      more: 'Show more',
      less: 'Show less',
      notFound: 'We could not find this race',
      back: 'Back',
      unconfirmed: 'Unconfirmed',
      retry: 'Retry',
      cancel: 'Cancel',
    },
    tabs: {
      track: 'Run',
      leaderboard: 'Leaderboard',
      feed: 'Races',
      myRaces: 'Saved',
      settings: 'Profile',
    },
    track: {
      newSession: 'New session',
      pause: 'Pause',
      resume: 'Resume',
      paused: 'Paused',
      checkpointFound: 'You have an unfinished session. Continue it or discard it?',
      close: 'Close',
      // Session-end map screen — see the ES entry's comment.
      done: 'Done',
      recenterFence: 'Center on the territory',
      start: 'Start',
      stop: 'Finish',
      starting: 'Finding signal…',
      distance: 'Distance',
      time: 'Time',
      area: 'Area',
      pace: 'Pace',
      waiting: 'Waiting for your first location…',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      recenter: 'Re-center on my location',
      overview: 'View whole route',
      mapUnavailable: "We couldn't load the map. Your route is still being recorded.",
      permission:
        'We need location permission to trace your route. Turn it on in your phone settings.',
      unavailable: "We couldn't access GPS on this device.",
      keepOpen: 'Keep the screen on — locking your phone stops recording.',
      keepAwakeFailed:
        "We couldn't keep the screen on — avoid locking your phone or recording may stop.",
      backgroundGap: 'Recording paused while the app was in the background.',
      // See the ES entries for why this copy is worded the way it is.
      paceGuardTitle: "Looks like you're not running",
      paceGuardBody:
        'You’ve been moving faster than a run for the last 30 seconds, so we ended the session. Nothing was saved — territory only counts when you cover it on foot.',
      paceGuardDismiss: 'Got it',
      // Split credited/uncredited — see the ES entry's comment.
      gapNotice: {
        one: '1 background interruption (%{duration}) — ~%{credited} counted as a straight line, ~%{uncredited} left unrecorded.',
        other: '%{count} background interruptions (%{duration}) — ~%{credited} counted as a straight line, ~%{uncredited} left unrecorded.',
      } as PluralForm,
      searching: 'Searching for GPS signal…',
      accuracy: 'Accuracy: %{m} m',
      weakSignal: 'Weak signal — move into open sky to start tracing.',
      degradedSignal: 'Weak signal — still tracking, with less precision.',
      summaryTitle: 'Territory claimed',
      noFence:
        'Your route was too short to enclose an area. Run a loop and try again.',
      save: 'Save territory',
      saving: 'Saving…',
      saved: 'Territory saved',
      discard: 'Discard',
      // Task 2 — see the Spanish keys' comment: auto-save means there is
      // usually already a server row by the time the summary renders, so
      // "Discard" (which never touched the server) stopped being honest.
      // `discard` above stays as-is — it's still used by the unfinished-
      // checkpoint recovery prompt, which never reaches the server.
      deleteRun: 'Delete run',
      deleting: 'Deleting…',
      deleteConfirmBody:
        "This deletes your record and this territory. Ground you already took from other runners during this session won't be returned to them.",
      deleteConfirmAction: 'Delete anyway',
      deleteFailedNetwork:
        "We couldn't delete your territory — check your connection. It's still saved, you can retry.",
      deleteFailedAuth: "We couldn't confirm your session to delete it. Please try again.",
      deleteFailedDisabled:
        "Online saving isn't available in this build, so we can't delete it from here.",
      // Distinct from deleteFailedNetwork on purpose — this isn't a
      // connection problem, and "check your connection" would send the
      // runner chasing a WiFi bar that was never the issue. Retrying won't
      // help here — see deleteRun()'s 'denied' reason.
      deleteFailedDenied:
        "We can't delete territories from here yet — that's coming soon. It's still safely saved.",
      syncFailedNetwork:
        "We couldn't save your territory — check your connection. Your route is still here, you can retry.",
      syncFailedAuth: "We couldn't create your session. Please try again.",
      // Distinct from syncFailedNetwork: this run was retried until the
      // queue gave up on it (see upload-queue.ts's MAX_ATTEMPTS) — it is
      // genuinely gone, not just waiting on a signal.
      syncFailedAbandoned:
        "We couldn't save your territory after several tries, and it's no longer in the queue. It's lost.",
      syncDisabled: "Online saving isn't available in this build yet.",
      retry: 'Retry',
      pastFencesFailed: "We couldn't load your previous territories.",
      allInsideZone:
        'Your whole session happened inside your privacy zone, so we can\u2019t save it without revealing where you live. Start a little further out.',
      zoneMasked:
        'We trimmed the start and end of your route for your privacy zone. What you see here is what gets uploaded.',
      queued:
        "Saved to your phone. We'll upload it automatically next time you open the app with a signal — closing the app won't lose it now.",
      pendingUploads: {
        one: '1 session saved on your phone, waiting to upload.',
        other: '%{count} sessions saved on your phone, waiting to upload.',
      } as PluralForm,
      // See the ES entries' comment: tookArea/tookFrom are unchanged and
      // unused — first-to-claim tiles can't actually TAKE ground (no decay
      // yet), so crossedTiles/crossedFrom say the true, weaker thing.
      crossedTiles: {
        one: 'You crossed 1 tile already claimed',
        other: 'You crossed %{count} tiles already claimed',
      } as PluralForm,
      crossedFrom: {
        one: 'from 1 runner',
        other: 'from %{count} runners',
      } as PluralForm,
      tiles: 'Tiles',
      tilesHeld: 'You now hold %{count} tiles in %{region}.',
      tilesUnavailable: "We couldn't confirm your tiles this time — your run is still saved.",
      // See the ES entry's comment: legacy enclosure area, shown small and
      // explicitly labelled as no-longer-authoritative.
      legacyArea: 'Old model: %{area} (no longer counts toward your territory)',
    },
    leaderboard: {
      title: 'Leaderboard',
      soonTitle: 'Coming soon',
      soonBody:
        "This is where you'll see who holds the most territory. For now, go run and build yours — it all counts once the board opens.",
      global: 'Global',
      anonymous: 'Anonymous',
      // See the ES entries' comment: unchanged, no longer rendered.
      runs: {
        one: '1 session',
        other: '%{count} sessions',
      } as PluralForm,
      flagged: {
        one: '1 flagged session',
        other: '%{count} flagged sessions',
      } as PluralForm,
      tiles: {
        one: '1 tile',
        other: '%{count} tiles',
      } as PluralForm,
      flaggedTiles: {
        one: '1 tile from a flagged run',
        other: '%{count} tiles from flagged runs',
      } as PluralForm,
      empty: 'Nobody has captured territory yet.\nBe the first.',
      emptyRegion:
        'Nobody has captured territory in %{city} yet.\nBe the first — or check the global board.',
      error: "We couldn't load the board. Check your connection.",
      disabled: 'Online saving is not configured in this build.',
    },
    feed: {
      title: 'Races',
      search: 'Search race or city…',
      empty: 'No races found.',
      otherCities: {
        one: '1 race in another city',
        other: '%{count} races in other cities',
      } as PluralForm,
      updated: 'Data updated',
      updateFailed: 'We could not update the data',
      thisWeek: 'This week',
      nextRace: 'Next race',
      walksShelf: 'Walks',
      regOpen: 'Registration open',
    },
    filters: {
      '3K': '3K',
      '5K': '5K',
      '10K': '10K',
      '15K': '15K',
      half: 'Half',
      '30K': '30K',
      full: 'Full',
      ultra: 'Ultra',
      tbd: 'TBD',
      title: 'Filters',
      distance: 'Distance',
      date: 'Date',
      reset: 'Reset',
      clearAll: 'Clear all',
      done: 'Done',
      presetThisMonth: 'This month',
      presetNext3: 'Next 3 months',
      presetAll: 'All',
    },
    detail: {
      buy: 'Buy ticket',
      noLink: 'Registration coming soon',
      canceled: 'Race canceled',
      viewRegistration: 'View registration',
      save: 'Save',
      saved: 'Saved',
      saveFailed: "We couldn't save this race on this device. Please try again.",
      addCalendar: 'Add to calendar',
      calendarAdded: 'Added to your calendar',
      calendarAddedNoTime:
        "Added to your calendar as an all-day event — the organizer hasn't confirmed a start time yet.",
      calendarAlready: 'This race is already in your calendar.',
      calendarFailed: "We couldn't add it to your calendar. Please try again.",
      calendarNoDate: 'This race has no confirmed date yet.',
      permission: 'We need permission to access your calendar.',
      viewSource: 'View source',
      close: 'Close',
      openBrowser: 'Open in browser',
      checkoutFailed:
        "We couldn't open the registration here. The link may no longer work, or the organizer may not allow it to open inside the app.",
      checkoutBlocked: "Not loading? Open it in your browser",
      openMaps: 'Open in Maps',
      approxLocation: 'Approximate start location',
      share: 'Share',
      shareMessage: '%{name} — %{date}',
    },
    myraces: {
      title: 'My races',
      empty: "You haven't saved any races yet.\nBrowse and save the ones you like.",
      pastSection: 'Past',
      upcomingSection: 'Upcoming',
      storageBlocked:
        "This browser doesn't allow saving data (private mode, for example), so your races won't be kept after you close the app.",
      missing: {
        one: '1 saved race is no longer listed — the organizer pulled it from the calendar.',
        other: '%{count} saved races are no longer listed — the organizer pulled them from the calendar.',
      } as PluralForm,
      clearMissing: 'Remove them from my list',
      remove: 'Remove from my races',
      tabRaces: 'Races',
      tabFences: 'Territories',
      fencesEmpty:
        "No territory captured yet.\nStart a session in Run to draw your first fence.",
      fencesError: "We couldn't load your territories. Check your connection.",
      fencesDisabled: 'Online saving is not configured in this build.',
      fenceFlagged:
        "We flagged this session \u2014 the speed doesn't look like running. It still counts toward your territory.",
      fenceLost: 'You lost %{area} of this territory',
      fenceFullyTaken: 'This territory was taken from you entirely',
      // Territories map detail card — see the ES entry's comment.
      pendingLabel: "Not uploaded yet — will retry on its own",
    },
    city: {
      title: 'Choose your city',
      useLocation: 'Use my location',
      detectFailed: "We couldn't detect your location — pick your city manually.",
      mxOnly: 'Available in Mexico for now.',
      emptyRegion: "No races in %{city} yet.\nWe're working on it — explore Monterrey meanwhile.",
      locationOn: 'using your location',
    },
    settings: {
      title: 'Settings',
      version: 'Version',
      debugCopied: 'Copied %{count} points to clipboard.',
      debugCopiedCountersOnly: 'Copied pilot counters to clipboard.',
      diagnosticTitle: 'Diagnostics',
      diagnosticBody:
        "Which account this device is using, and what the server returns for it. Useful when your territory doesn't show up.",
      diagnosticSession: 'Session',
      diagnosticEmail: 'Email',
      diagnosticTerritories: 'Territories on the server',
      diagnosticQueued: 'Queued to upload',
      diagnosticNoSession: 'no session',
      diagnosticAnonymous: '— (anonymous account)',
      diagnosticFailed: 'query failed (%{reason})',
      diagnosticSkipped: "(%{count} couldn't be read)",
      diagnosticRecheck: 'Check again',
      diagnosticChecking: 'Checking…',
      diagnosticCopy: 'Copy',
      diagnosticCopied: 'Copied',
      support: 'Support',
      theme: 'Appearance',
      themeSystem: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
      language: 'Language',
      location: 'Location',
      locationOn: 'On',
      locationOff: 'Blocked',
      locationNotSet: 'Not enabled',
      locationUnknown: 'Not checked',
      locationOnHint:
        'We can trace your runs. Only used while the app is open and a session is running.',
      locationOffHint:
        "Without this permission we can't trace your runs or capture territory.",
      locationEnable: 'Enable location',
      locationOpenSettings: 'Open phone settings',
      locationBrowserBlocked: 'Unblock location in your browser',
      reminders: 'Reminders',
      remindersHint:
        'We’ll remind you 3 days before and the night before each race you save.',
      remindersOnHint:
        'We’ll remind you 3 days before and the night before each race you save.',
      remindersDenied:
        'You didn’t allow notifications. Turn them on in your phone settings to use reminders.',
      privacyZone: 'Privacy zone',
      zoneSetHere: 'Use my location',
      zoneRemove: 'Remove',
      zoneSetting: 'Saving…',
      zoneOnHint:
        'On. We trim the first and last %{m} m of every session before uploading it, with a random margin so the centre can\u2019t be worked out. The point stays on this phone \u2014 it is never uploaded.',
      zoneOffHint:
        'Without a privacy zone, the exact start and end of your sessions are uploaded and visible to anyone using the app. Set it where you live.',
      zoneFailed: "We couldn\u2019t save your zone. Check location permission and try again.",
      displayName: 'Leaderboard name',
      displayNamePlaceholder: 'Anonymous',
      displayNameHint:
        'The name others see on the leaderboard, and only you can have it. Leave it empty to show up as Anonymous.',
      displayNameSaved: 'Name saved',
      displayNameFailed: "We couldn't save your name. Check your connection.",
      displayNameDirtyHint:
        'Changing your name updates it across the whole leaderboard, including your past standings.',
      displayNameSave: 'Save',
      displayNameDiscard: 'Discard',
      displayNameTaken: 'That name is already taken. Try another one.',
      displayNameReserved: 'That name is reserved. Pick another one.',
      // Profile section (Settings tab redesign) — the identity concerns
      // grouped at the top of the screen, plus the honest statement of
      // account status the owner asked for.
      sectionProfile: 'Profile',
      sectionPreferences: 'Preferences',
      sectionLocation: 'Location & privacy',
      sectionAbout: 'About',
      // See the Spanish block for what these are and why the row labels
      // themselves have no new keys.
      groupAccount: 'Account',
      groupApp: 'App',
      navProfileHint: 'Your name on the leaderboard',
      navAccountHint: 'Link your email so you keep your territory',
      navPreferencesHint: 'Appearance, language and reminders',
      navLocationHint: 'Location permission and your privacy zone',
      navPrivacyHint: 'What we collect and what we don’t',
      navAboutHint: 'Version and support',
      accountTitle: 'Your account',
      accountBody:
        "This device has an anonymous account for saving your territories. Switch browsers or devices, or clear site data, and that account — and any territory it holds — stops showing up. Add your email so your progress follows you wherever you sign in.",
      accountEmailPlaceholder: 'you@email.com',
      accountSendCode: 'Send code',
      accountSending: 'Sending…',
      accountEmailInvalid: 'Enter a valid email address.',
      accountCodeSent: 'We sent a code to %{email}. Check your inbox.',
      accountCodeSpam: 'If it does not arrive within a couple of minutes, check your spam folder.',
      accountCodePlaceholder: '6-digit code',
      accountVerify: 'Confirm',
      accountVerifying: 'Confirming…',
      accountCodeInvalid: "That code is wrong or expired. Try again.",
      accountChangeEmail: 'Change email',
      accountFailed: "Something failed. Check your connection and try again.",
      // Only the SIGN IN path (account.ts) replaces this device's local
      // identity — shown only when startEmailAuth reports mode:'signin',
      // i.e. the email already belongs to an account linked elsewhere.
      accountSwitchWarning:
        "That email already has an account. Confirming will switch this device to it — any territory saved only here will stop showing.",
      accountLinked: 'Account linked: %{email}',
      // Shown by email-link-banner.tsx after a clicked email link finishes
      // signing in (not the in-app code path — see supabase.ts's
      // emailLinkType). This is the SIGN-IN case specifically: the swap
      // already happened by the time this renders, so unlike
      // accountSwitchWarning above (which warns BEFORE confirming, in the
      // code-entry flow) this can only disclose it after the fact.
      accountLinkedSwapped:
        "This device is now signed in as %{email}. If it had territory saved only here under a different account, you may not see it anymore.",
      // First-save name prompt (name-prompt.tsx) — asked once, at the
      // moment a run is first saved, never on first app open.
      namePromptTitle: 'How do you want to show up on the leaderboard?',
      namePromptBody:
        "Give your territory a name. If you'd rather not, you'll keep showing up as Anonymous.",
      namePromptSave: 'Save',
      namePromptSkip: 'Not now',
      namePromptSaving: 'Saving…',
      namePromptFailed: "We couldn't save your name. You can try again or leave it for later.",
    },
    privacy: {
      title: 'Privacy',
      collectedTitle: 'What we collect',
      collectedLocation:
        "Approximate location: if you grant GPS permission, we use it only on this device to show nearby races. It never leaves your phone.",
      collectedIp:
        "If GPS isn't available or you didn't grant permission, we estimate your city from your IP address using the ipapi.co service. Your IP is sent to ipapi.co at that point — it's the only thing that ever leaves your device, and only when GPS isn't available.",
      collectedSaved:
        'Saved races: the IDs of races you save stay on this device only (SQLite on iOS/Android, local storage on the web version). Nothing syncs to any server.',
      collectedReminders:
        'Reminders: if you turn them on, your phone schedules the notifications locally. We use no push notifications and no messaging servers — nothing leaves your device, and turning them off cancels all of them.',
      collectedTerritory:
        'Territory: when you record a run on the Run tab, the GPS route and the area it encloses ARE saved to our server (Supabase). The game needs that to work — without shared data there is no leaderboard and no overlapping territory. Only what you record is stored; opening the app or browsing races never sends your location.',
      collectedQueue:
        'Pending sessions: if an upload fails (no signal) we store the route on this phone so it is not lost, and upload it once signal returns. It is deleted as soon as it uploads, or if you delete the run — closing the summary screen does not delete it.',
      collectedCheckpoint:
        "In-progress runs: while you're recording, we save your full route (before privacy-zone trimming) on this phone every few seconds, so it isn't lost if the app closes on its own. It's cleared as soon as you save or discard the session — privacy-zone trimming only applies when you save.",
      collectedDebug:
        "Technical diagnostics: we keep the full (untrimmed) route of your last finished session on this phone, so measurement issues can be investigated if you report one. Only accessed by hand from Settings, and each new session replaces the last.",
      collectedIdentity:
        "Identity: saving your first territory creates an anonymous account tied to this device — no email or password required. If you add your email from Settings so your progress follows you to another device, that email is stored with your account — it's optional and never required to use the app.",
      collectedZone:
        'Privacy zone: you can mark where you live in Settings. We trim the start and end of every session before uploading it, with a random margin so the centre can\u2019t be worked out from several sessions. That point is stored only on this phone and is never uploaded to any server.',
      collectedVisible:
        'Visible to others: the territories you save and the name you pick in Settings appear on the leaderboard to anyone using the app, and the area you captured shows on the map. With no name set you appear as Anonymous. Every run you finish saves automatically now — you can no longer opt out of saving. If you would rather not appear, delete it afterward from the summary screen or the Territories tab (this does not undo any ground it already took from other runners while it was live).',
      notTitle: "What we don't do",
      notAccounts: 'No email, password, or personal details are needed to use the app.',
      notTracking: "No tracking your activity beyond the runs you record yourself, and no analytics.",
      notSharing:
        "We don't sell your data or share it with third parties. Inside the app, the only thing other runners see is what's on the leaderboard, described above.",
      notServer:
        'Apart from the territory you record, nothing else goes to a server: your saved races, language, and reminders stay on this device only.',
      deleteTitle: 'Deleting your data',
      deleteBody:
        'Anything stored locally (saved races, language, reminders) is removed by deleting the app from your phone, or clearing the site data in your browser. To delete territories you uploaded, contact us through the support link and we will remove your anonymous account and its runs.',
      ipapiLink: 'ipapi.co privacy policy',
    },
  },
};

const i18n = new I18n(translations);
i18n.enableFallback = true;
i18n.defaultLocale = 'es';

type Locale = 'es' | 'en';
const deviceLocale: Locale = getLocales()[0]?.languageCode === 'en' ? 'en' : 'es';
// Keep the singleton consistent with the initial provider state from the
// very first render — it is otherwise only ever mutated from an effect or
// an event handler (see LocaleProvider below), never during render.
i18n.locale = deviceLocale;

const PREF_LOCALE = 'locale';

interface I18nValue {
  t: (key: string, options?: Record<string, unknown>) => string;
  locale: Locale;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * The persisted locale choice, or the device default. Read synchronously from
 * a `useState` lazy initializer, not an effect: the effect version rendered
 * the whole tree in Spanish first and then switched, so an English user saw a
 * flash of Spanish on every cold start — and it tripped
 * `react-hooks/set-state-in-effect`, which matters with `reactCompiler` on.
 *
 * Still not module scope: on native that would run before the database is
 * open. initDb() here is idempotent and removes any provider-ordering
 * dependency.
 */
function loadInitialLocale(): Locale {
  try {
    initDb();
  } catch {
    // Ignore — getPref below degrades to null when the db isn't open.
  }
  let locale = deviceLocale;
  try {
    const stored = getPref(PREF_LOCALE);
    if (stored === 'es' || stored === 'en') locale = stored;
  } catch {
    // Storage failure — fall back to the device-derived locale.
  }
  // Point the singleton at the same value BEFORE returning. `t()` reads
  // `i18n.locale`, not React state, so deferring this to an effect would
  // render the entire first paint in the wrong language — which is what the
  // effect version did, and why an English user saw a flash of Spanish on
  // every cold start. Assigning here is safe: the initializer runs once per
  // mount and is idempotent.
  i18n.locale = locale;
  return locale;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(loadInitialLocale);

  const setLocale = useCallback((l: Locale) => {
    i18n.locale = l;
    setLocaleState(l);
    try {
      setPref(PREF_LOCALE, l);
    } catch {
      // A storage failure must never crash the language toggle.
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ t: (key, options) => i18n.t(key, options), locale, setLocale }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within a LocaleProvider');
  return ctx;
}

/** Human countdown label for a race date, localized. */
export function useCountdown() {
  const { t } = useI18n();
  return useCallback(
    (days: number | null): string => {
      if (days === null) return t('common.tbd');
      if (days < 0) return t('common.past');
      if (days === 0) return t('common.today');
      if (days === 1) return t('common.oneDayAway');
      return t('common.daysAway', { count: days });
    },
    [t],
  );
}
