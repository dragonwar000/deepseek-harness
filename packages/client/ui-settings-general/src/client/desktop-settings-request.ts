/** Desktop-shell requests to open Settings on one section, checked against the registered sections. */

/** Settings shell store actions a request drives. */
export interface SettingsRequestActions {
  open(): void
  openSection(id: string): void
}

/**
 * Open Settings on the requested section. An id no `settings.section` entry registers logs a warning
 * and opens Settings on its default section instead.
 * @param sectionId - Section id received from the Desktop shell.
 * @param isRegistered - Whether a `settings.section` entry currently registers an id.
 * @param actions - Settings shell store actions.
 */
export function openRequestedSettingsSection(
  sectionId: string, isRegistered: (id: string) => boolean, actions: SettingsRequestActions,
): void {
  if (isRegistered(sectionId)) {
    actions.openSection(sectionId)
    return
  }
  console.warn(`ui-settings-general: Desktop requested unregistered Settings section "${sectionId}"; opening the default section`)
  actions.open()
}
