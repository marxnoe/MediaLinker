import { Component } from '@angular/core';
import { NaCard, NaCode, NaHeading, NaStack, NaText } from 'newang';

/** How to install and use `ml`, the MediaLinker command line tool. */
@Component({
  selector: 'app-cli',
  imports: [NaCard, NaCode, NaHeading, NaStack, NaText],
  styleUrl: './cli.css',
  templateUrl: './cli.html',
})
export class Cli {
  protected readonly server = location.origin;
}
