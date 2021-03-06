/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Peter Flannery. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import appSettings from '../../appSettings';
import appContrib from '../../appContrib';
import * as CommandFactory from '../../commands/factory';
import {
  renderMissingDecoration,
  renderInstalledDecoration,
  renderOutdatedDecoration,
  renderNeedsUpdateDecoration,
  renderPrereleaseInstalledDecoration
} from '../../editor/decorations';
import { AbstractCodeLensProvider } from '../abstract/abstractCodeLensProvider';
import { extractPackageLensDataFromText } from '../shared/jsonPackageParser'
import { IPackageCodeLens } from '../shared/definitions';
import { generateCodeLenses } from '../shared/codeLensGeneration';
import { resolvePackageLensData } from '../shared/dependencyParser';
import { npmGetOutdated, npmPackageDirExists } from './npmClientApiCached.js';
import { resolveNpmPackage } from './npmPackageResolver';

export class NpmCodeLensProvider extends AbstractCodeLensProvider {
  _outdatedCache: Array<any>;
  _documentPath: '';

  constructor() {
    super();
    this._outdatedCache = [];
    this._documentPath = '';
  }

  get selector() {
    return {
      language: 'json',
      scheme: 'file',
      pattern: '**/package.json',
      group: ['tags', 'statuses'],
    }
  }

  provideCodeLenses(document, token) {
    if (appSettings.showVersionLenses === false) return [];

    const path = require('path');
    this._documentPath = path.dirname(document.uri.fsPath);

    // extract package lens data
    const packageLensData = extractPackageLensDataFromText(document.getText(), appContrib.npmDependencyProperties)
    if (packageLensData.length === 0) return [];

    // resolve package lenses (as promises)
    const packageLensResolvers = resolvePackageLensData(
      packageLensData,
      appContrib,
      resolveNpmPackage.bind(null, this._documentPath)
    );
    if (packageLensResolvers.length === 0) return [];

    appSettings.inProgress = true;

    // create code lenses from package lenses
    return generateCodeLenses(packageLensResolvers, document)
      .then(codeLenses => {
        if (appSettings.showDependencyStatuses)
          return this.updateOutdated()
            .then(_ => codeLenses)

        return codeLenses;
      })
      .catch(err => {
        console.log(err)
      })
  }

  evaluateCodeLens(codeLens: IPackageCodeLens) {
    if (codeLens.isMetaType('github'))
      return CommandFactory.createGithubCommand(codeLens);

    if (codeLens.isMetaType('file'))
      return CommandFactory.createLinkCommand(codeLens);

    if (codeLens.packageUnexpectedError())
      return CommandFactory.createPackageUnexpectedError(codeLens);

    if (codeLens.packageNotFound())
      return CommandFactory.createPackageNotFoundCommand(codeLens);

    if (codeLens.packageNotSupported())
      return CommandFactory.createPackageNotSupportedCommand(codeLens);

    // check if this is a tagged version
    if (codeLens.isTaggedVersion())
      return CommandFactory.createTaggedVersionCommand(codeLens);

    // generate decoration
    if (appSettings.showDependencyStatuses)
      this.generateDecoration(codeLens);

    // check if the entered version is valid
    if (codeLens.isInvalidVersion())
      return CommandFactory.createInvalidVersionCommand(codeLens);

    // check if the entered version matches a registry version
    if (codeLens.versionMatchNotFound())
      return CommandFactory.createVersionMatchNotFoundCommand(codeLens);

    // check if this matches prerelease version
    if (codeLens.matchesPrereleaseVersion())
      return CommandFactory.createMatchesPrereleaseVersionCommand(codeLens);

    // check if this is the latest version
    if (codeLens.matchesLatestVersion())
      return CommandFactory.createMatchesLatestVersionCommand(codeLens);

    // check if this satisfies the latest version
    if (codeLens.satisfiesLatestVersion())
      return CommandFactory.createSatisfiesLatestVersionCommand(codeLens);

    // check if this is a fixed version
    if (codeLens.isFixedVersion())
      return CommandFactory.createFixedVersionCommand(codeLens);

    const tagVersion = codeLens.getTaggedVersion();
    return CommandFactory.createVersionCommand(
      codeLens.package.version,
      tagVersion,
      codeLens
    );
  }

  // get the outdated packages and cache them
  updateOutdated() {
    return npmGetOutdated(this._documentPath)
      .then(results => this._outdatedCache = results)
      .catch(err => {
        console.log("npmGetOutdated", err);
      });
  }

  generateDecoration(codeLens) {
    const documentPath = this._documentPath;
    const currentPackageName = codeLens.package.name;

    const packageDirExists = npmPackageDirExists(documentPath, currentPackageName);
    if (!packageDirExists) {
      renderMissingDecoration(codeLens.replaceRange);
      return;
    }

    Promise.resolve(this._outdatedCache)
      .then(outdated => {
        const findIndex = outdated.findIndex(
          (entry: any) => entry.name === currentPackageName
        );

        if (findIndex === -1) {
          renderInstalledDecoration(
            codeLens.replaceRange,
            codeLens.package.meta.tag.version
          );
          return;
        }

        const current = outdated[findIndex].current;
        const entered = codeLens.package.meta.tag.version;

        // no current means no install at all
        if (!current) {
          renderMissingDecoration(codeLens.replaceRange);
          return;
        }

        // if npm current and the entered version match it's installed
        if (current === entered) {

          if (codeLens.matchesLatestVersion())
            // up to date
            renderInstalledDecoration(
              codeLens.replaceRange,
              current
            );
          else if (codeLens.matchesPrereleaseVersion())
            // ahead of latest
            renderPrereleaseInstalledDecoration(
              codeLens.replaceRange,
              entered
            );
          else
            // out of date
            renderOutdatedDecoration(
              codeLens.replaceRange,
              current
            );

          return;
        }

        // signal needs update
        renderNeedsUpdateDecoration(
          codeLens.replaceRange,
          current
        );

      })
      .catch(console.error);

  }

} // End NpmCodeLensProvider
