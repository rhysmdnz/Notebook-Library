import { Asset, FlatNotepad, Note, Notepad, Section } from './index';
import { format, parse, parseISO } from 'date-fns';
import { OptionsV2, parseString } from 'xml2js';
import { NoteElement, Source } from './Note';
import { pd } from 'pretty-data';
import { gfm } from 'turndown-plugin-gfm';
import TurndownService from 'turndown';
import { NotepadShell } from './interfaces';
import { decrypt } from './crypto';
import {
	ENEX_FORMAT,
	IMPORTED_EVERNOTE_NOTEBOOK_TIME,
	IMPORTED_MARKDOWN_NOTE_TIME,
	LAST_MODIFIED_FORMAT
} from './date-formats';

export namespace Translators {
	export namespace Json {
		/**
		 * @param {string | object} json A {@link Notepad} object in JSON format or as a plain object
		 * @param {string | undefined} passkey The passkey to decrypt the notepad if it's encrypted.
		 * @returns {Notepad}
		 */
		export async function toNotepadFromNotepad(json: string | object, passkey?: string): Promise<Notepad> {
			const jsonObj: NotepadShell = (typeof json === 'string') ? JSON.parse(json) : json;
			let notepad = new Notepad(jsonObj.title, {
				lastModified: parse(jsonObj.lastModified, LAST_MODIFIED_FORMAT, new Date()),
				notepadAssets: jsonObj.notepadAssets || [],
				crypto: jsonObj.crypto
			});

			if (typeof jsonObj.sections === 'string') {
				if (!passkey) throw new Error('This notepad is encrypted. A passkey is needed to unlock it.');
				return await decrypt(jsonObj, passkey);
			}

			// Restore sections
			jsonObj.sections.forEach(section => notepad = notepad.addSection(restoreSection(section)));

			return notepad;

			function restoreSection(section: Section): Section {
				let restored = new Section(section.title).clone({ internalRef: section.internalRef });
				section.sections.forEach(s => restored = restored.addSection(restoreSection(s)));
				section.notes.forEach(n => restored = restored.addNote(restoreNote(n)));

				return restored;
			}

			function restoreNote(note: Note) {
				return new Note(note.title, note.time, note.elements, note.bibliography, note.internalRef);
			}
		}

		/**
		 * @param {string | object} json A {@link Notepad} object in JSON format or as a plain object
		 * @param {string | undefined} passkey The passkey to decrypt the notepad if it's encrypted.
		 * @returns {FlatNotepad}
		 */
		export async function toFlatNotepadFromNotepad(json: string | object, passkey?: string): Promise<FlatNotepad> {
			return (await toNotepadFromNotepad(json, passkey)).flatten();
		}

		/**
		 * @param {string} json A Jupyter notebook (.ipynb)
		 * @returns {string} A Markdown translation of that notebook
		 */
		export function toMarkdownFromJupyter(json: string): string {
			const np = JSON.parse(json);

			let mdString = '';
			np.cells.forEach(cell => {
				if (cell.cell_type === 'markdown') cell.source.forEach(line => mdString += line+'\n');

				if (cell.cell_type === 'code') {
					mdString += '\n```\n';
					cell.source.forEach(line => mdString += line+'\n');

					cell.outputs.forEach(output => {
						if (!output.text) return;
						mdString += '\n--------------------\n';
						mdString += 'Output:\n';
						output.text.forEach(t => mdString += t);
						mdString += '\n--------------------\n';
					});

					mdString += '```\n';
				}
			});

			return mdString;
		}
	}

	export namespace Xml {
		/**
		 * @param {string} xml The NPX file's contents as a string
		 * @returns {Promise<Notepad>}
		 */
		export async function toNotepadFromNpx(xml: string): Promise<Notepad> {
			const res = await parseXml(xml);

			const lastModifiedStr: string = res.notepad.$.lastModified;
			let notepad = new Notepad(res.notepad.$.title, { lastModified: lastModifiedStr ? parse(lastModifiedStr, LAST_MODIFIED_FORMAT, new Date()) : new Date() });

			// Parse sections/notes
			if (res.notepad.section) {
				res.notepad.section.forEach(s => notepad = notepad.addSection(parseSection(s)));
			}

			// Parse assets
			if (res.notepad.assets) {
				const assets = await Promise.all<Asset | null>(((res.notepad.assets[0] || {}).asset || []).map(async item => {
					try {
						return new Asset(await dataURItoBlob(item._), item.$.uuid);
					} catch (e) {
						console.warn(`Can't parse the asset ${item.$.uuid}\n${e}`);
						return null;
					}
				}));

				assets
					.filter(asset => asset !== null)
					.forEach(asset => notepad = notepad.addAsset(asset!));
			}

			// Convert inline assets to full-assets
			const flatNotepad = notepad.flatten();
			const convertedAssets: Asset[] = [];
			const convertedNotes = await Promise.all(Object.values(flatNotepad.notes)
				.map(async note => {
					let elements: NoteElement[] = [];

					// Import inline assets
					for (const element of note.elements) {
						// If it's not a binary asset with inline base64, skip
						if (element.type === 'markdown' || element.content === 'AS') {
							elements.push(element);
							continue;
						}

						try {
							const asset = new Asset(await dataURItoBlob(element.content));
							elements.push({
								...element,
								content: 'AS',
								args: {
									...element.args,
									ext: asset.uuid
								}
							});
							convertedAssets.push(asset);

						} catch (e) {
							console.warn(`Can't parse asset\n${e}`);
						}
					}

					// Update the note with the new elements
					return flatNotepad.notes[note.internalRef].clone({
						elements
					});
				}));

			convertedNotes.forEach(note => flatNotepad.notes[note.internalRef] = note);

			return flatNotepad.toNotepad().clone({
				assets: [
					...notepad.assets,
					...convertedAssets
				],
				notepadAssets: [
					...notepad.notepadAssets,
					...convertedAssets.map(asset => asset.uuid)
				]
			});

			function parseSection(sectionObj: any): Section {
				let section = new Section(sectionObj.$.title);

				// Insert sub-sections recursively because notepads are trees
				(sectionObj.section || []).forEach(item => section = section.addSection(parseSection(item)));

				// Parse notes
				(sectionObj.note || []).forEach(item => {
					const posixTimeStr: string = item.$.time;

					section = section.addNote(new Note(
						item.$.title,
						parseISO(posixTimeStr).getTime(),
						[
							...([
									'markdown',
									'drawing',
									'image',
									'file',
									'recording',
									'pdf'
								]
								.map(type =>
									(item[type] || []).map(e => {
										return {
											type: type,
											args: {
												...e.$,
												canOptimise: e.$.canOptimise && (e.$.canOptimise.toLowerCase() == 'true')
											},
											content: e._ || ''
										} as NoteElement;
									})
								)
							).reduce((acc: NoteElement[], element: NoteElement[]) => acc.concat(element))
						],
						[
							...(item.bibliography[0].source || []).map(s => {
								return {
									id: s.$.id,
									item: s.$.item,
									content: s._
								} as Source;
							})
						]
					))
			});

				return section;
			}
		}

		/**
		 * @param {string} xml The exported Evernote notepad's XML as a string
		 * @returns {Promise<Notepad>}
		 */
		export async function toNotepadFromEnex(xml: string): Promise<Notepad> {
			const res = await parseXml(xml, { trim: true, normalize: false });
			const exported = res['en-export'];

			let notepad = new Notepad(`${exported.$.application} Import ${format(parse(exported.$['export-date'], ENEX_FORMAT, new Date()), IMPORTED_EVERNOTE_NOTEBOOK_TIME)}`);
			let section = new Section('Imported Notes');

			(await Promise.all<Note>((exported.note || [])
				.map(async enexNote => {
					let note = new Note((enexNote.title || ['Imported Note'])[0], parse(enexNote.created[0], ENEX_FORMAT, new Date()).getTime(), [
						// Add the general note content (text/to-do)
						{
							type: 'markdown',
							args: {
								id: 'markdown1',
								x: '10px',
								y: '10px',
								width: '600px',
								height: 'auto',
								fontSize: '16px'
							},
							content: enmlToMarkdown(pd.xml(enexNote.content[0]))
						}
					]);

					let fileCount = 0;
					let imageCount = 0;

					await Promise.all(
						(enexNote.resource || []).reverse().map(async resource => {
							const asset = new Asset(await dataURItoBlob(
								`data:${resource.mime};base64,${resource.data[0]._.replace(/\r?\n|\r/g, '')}`
							));
							notepad = notepad.addAsset(asset);

							const y = 10 + (335 * (fileCount + imageCount));

							if (resource.mime[0].includes('image')) {
								note = note.addElement({
									type: 'image',
									args: {
										id: `image${++imageCount}`,
										x: '650px',
										y: y + 'px',
										width: 'auto',
										height: '300px',
										ext: asset.uuid
									},
									content: 'AS'
								});
							} else {
								// Add the resource as a file
								let filename;
								try {
									if (resource['resource-attributes'][0]['file-name']) {
										filename = resource['resource-attributes'][0]['file-name'][0];
									} else if (resource['resource-attributes'][0]['source-url']) {
										filename = resource['resource-attributes'][0]['source-url'][0].split('/').pop();
									} else {
										filename = `file${fileCount}.${resource.mime[0].split('/').pop()}`
									}
								} catch (e) {
									filename = 'imported-file' + fileCount;
								}

								note = note.addElement({
									type: 'file',
									args: {
										id: `file${++fileCount}`,
										x: '650px',
										y: y + 'px',
										width: 'auto',
										height: 'auto',
										ext: asset.uuid,
										filename
									},
									content: 'AS'
								});
							}
						})
					);

					return note;
				})))
				.forEach(note => section = section.addNote(note));

			return notepad.addSection(section);

			function enmlToMarkdown(enml: string): string {
				// Init Turndown service
				const service = new TurndownService();
				service.use(gfm);

				// Setup rules, these are like converters from the old to-markdown lib
				service.addRule('en-media', {
					filter: 'en-media',
					replacement: () => {
						return '`there was an attachment here`';
					}
				});

				service.addRule('crypt', {
					filter: 'en-crypt',
					replacement: () => '`there was encrypted text here`'
				});

				service.addRule('todo', {
					filter: 'en-todo',
					replacement: (content, node) =>
						`- [${(node.getAttributeNode('checked') && node.getAttributeNode('checked').value === 'true') ? 'x' : ' '}] ${content}`
				});

				// Clean input
				let lines = enml.split('\n');
				lines = lines.slice(3, lines.length - 1);
				const html = lines
					.map(line => line.trim())
					.join('\n')
					.replace(/^<en-media.*\/>$/gmi, tag => `${tag.substr(0, tag.length - 2)}>t</en-media>`);

				// Convert to markdown
				return service.turndown(html);
			}
		}

		function parseXml(xml: string, opts: OptionsV2 = {}): Promise<any> {
			return new Promise<any>((resolve, reject) => {
				parseString(xml, { trim: true, ...opts }, (err, res) => {
					if (err) reject(err);
					resolve(res);
				});
			});
		}
	}

	export namespace Markdown {
		/**
		 * @param {Array<MarkdownImport>} markdown A list of all the markdown to be imported into notes
		 */
		export function toNotepadFromMarkdown(markdown: MarkdownImport[]): Notepad {
			let importCounter = 0;

			const section = markdown
				.map(({ title, content }) => new Note(`${title} (Import ${++importCounter})`).clone({
					elements: [
						{
							type: 'markdown',
							content,
							args: { id: 'markdown1', x: '10px', y: '10px', width: '550px', height: 'auto', fontSize: '16px' }
						}
					]
				}))
				.reduce((section, note) => section.addNote(note), new Section('Imported Notes'));

			return new Notepad('Markdown Import ' + format(new Date(), IMPORTED_MARKDOWN_NOTE_TIME)).addSection(section);
		}

		export type MarkdownImport = { title: string, content: string };
	}

	// Thanks to http://stackoverflow.com/a/12300351/998467
	async function dataURItoBlob(dataURI: string) {
		// convert base64 to raw binary data held in a string
		// doesn't handle URLEncoded DataURIs - see SO answer #6850276 for code that does this
		let byteString = atob(dataURI.split(',')[1]);

		// separate out the mime component
		let mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];

		// write the bytes of the string to an ArrayBuffer
		let ab = new ArrayBuffer(byteString.length);
		let ia = new Uint8Array(ab);
		for (let i = 0; i < byteString.length; i++) {
			ia[i] = byteString.charCodeAt(i);
		}

		// write the ArrayBuffer to a blob, and you're done
		return new Blob([ia], { type: mimeString });
	}
}
