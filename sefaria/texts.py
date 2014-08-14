# -*- coding: utf-8 -*-
"""
texts.py -- backend core for manipulating texts, refs (citations), links, notes and text index records.

MongoDB collections handled in this file: index, texts, links, notes, history
"""
# noinspection PyUnresolvedReferences
import os
import re

# To allow these files to be run directly from command line (w/o Django shell)
os.environ['DJANGO_SETTINGS_MODULE'] = "settings"

# noinspection PyUnresolvedReferences
import copy
import regex
import bleach
from pprint import pprint
from bson.objectid import ObjectId
from django.utils import simplejson as json

# noinspection PyUnresolvedReferences
from sefaria.utils.util import list_depth, delete_template_cache, union
from sefaria.utils.users import user_link, is_user_staff
from sefaria.system.database import db
from sefaria.utils.hebrew import encode_hebrew_numeral, decode_hebrew_numeral, is_hebrew
from history import * #record_text_change, record_obj_change
import summaries
import counts

import logging
logging.basicConfig()
logger = logging.getLogger("texts")
#logger.setLevel(logging.DEBUG)
logger.setLevel(logging.ERROR)

def logdecorator(func):
	dlogger = logging.getLogger(__name__)
	dlogger.setLevel(logging.DEBUG)
	formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
	fh = logging.FileHandler('debug.log')
	fh.setLevel(logging.DEBUG)
	fh.setFormatter(formatter)
	if not dlogger.handlers:
		dlogger.addHandler(fh)
	def wrapper(*args, **kwargs):
		dlogger.debug("Calling {}".format(func.__name__))
		result = func(*args, **kwargs)
		dlogger.debug("Returning from {}".format(func))
		return result
	return wrapper

# HTML Tag whitelist for sanitizing user submitted text
ALLOWED_TAGS = ("i", "b", "br", "u", "strong", "em", "big", "small")

# Simple caches for indices, parsed refs, table of contents and texts list
indices = {}
he_indices = {}
parsed = {}
toc_cache = None
texts_titles_cache = None
he_texts_titles_cache = None
texts_titles_json = None


def get_index(book):
	"""
	Return index information about string 'book', but not the text.
	"""
	# look for result in indices cache
	res = indices.get(book)
	if res:
		return copy.deepcopy(res)

	if not book:
		return {"error": "No book provided."}

	book = (book[0].upper() + book[1:]).replace("_", " ")
	i = db.index.find_one({"titleVariants": book})

	# Simple case: found an exact match in the index collection
	if i:
		keys = ("sectionNames", "categories", "title", "heTitle", "length", "lengths", "maps", "titleVariants")
		i = dict((key,i[key]) for key in keys if key in i)
		if "sectionNames" in i:
			i["textDepth"] = len(i["sectionNames"])
		indices[book] = copy.deepcopy(i)
		return i

	# Try matching "Commentator on Text" e.g. "Rashi on Genesis"
	commentators = db.index.find({"categories.0": "Commentary"}).distinct("titleVariants")
	books = db.index.find({"categories.0": {"$in": ["Tanach", "Mishnah", "Talmud", "Halakhah"]}}).distinct("titleVariants")

	commentatorsRe = "^(" + "|".join(commentators) + ") on (" + "|".join(books) +")$"
	match = re.match(commentatorsRe, book)
	if match:
		i = get_index(match.group(1))
		bookIndex = get_index(match.group(2))
		i["commentaryBook"] = bookIndex["title"]
		i["commentaryCategories"] = bookIndex["categories"]
		i["categories"] = ["Commentary"] + bookIndex["categories"] + [bookIndex["title"]]
		i["commentator"] = match.group(1)
		if "heTitle" in i:
			i["heCommentator"] = i["heTitle"]
		i["title"] = i["title"] + " on " + bookIndex["title"]
		if "heTitle" in i and "heTitle" in bookIndex:
			i["heBook"] = i["heTitle"]
			i["heTitle"] = i["heTitle"] + u" \u05E2\u05DC " + bookIndex["heTitle"]
		i["sectionNames"] = bookIndex["sectionNames"] + ["Comment"]
		i["textDepth"] = len(i["sectionNames"])
		i["titleVariants"] = [i["title"]]
		if "length" in bookIndex:
			i["length"] = bookIndex["length"]
		indices[book] = copy.deepcopy(i)
		return i

	# TODO return a virtual index for shorthands

	return {"error": "Unknown text: '%s'." % book}


def get_he_index(he_book):
	"""
	Return index information for Hebrew book
	"""
	en_book = he_indices.get(he_book)
	if not en_book:
		i = db.index.find_one({"heTitleVariants": he_book})
		if i:
			en_book = i["title"]
			he_indices[he_book] = en_book
	if en_book:
		return get_index(en_book)

	logger.warning("In get_he_index: Can not find entry for %s", he_book)
	return {"error": "Unknown Hebrew text: %s" % he_book}


def merge_translations(text, sources):
	"""
	This is a recursive function that merges the text in multiple
	translations to fill any gaps and deliver as much text as
	possible.
	e.g. [["a", ""], ["", "b", "c"]] becomes ["a", "b", "c"]
	"""
	if not (len(text) and len(sources)):
		return ["", []]

	depth = list_depth(text)
	if depth > 2:
		results = []
		result_sources = []
		for x in range(max(map(len, text))):
			translations = map(None, *text)[x]
			remove_nones = lambda x: x or []
			result, source = merge_translations(map(remove_nones, translations), sources)
			results.append(result)
			# NOTE - the below flattens the sources list, so downstream code can always expect
			# a one dimensional list, but in so doing the mapping of source names to segments
			# is lost for merged texts of depth > 2 (this mapping is not currenly used in general)
			result_sources += source
		return [results, result_sources]

	if depth == 1:
		text = map(lambda x: [x], text)

	merged = map(None, *text)
	text = []
	text_sources = []
	for verses in merged:
		# Look for the first non empty version (which will be the oldest, or one with highest priority)
		index, value = 0, 0
		for i, version in enumerate(verses):
			if version:
				index = i
				value = version
				break
		text.append(value)
		text_sources.append(sources[index])

	if depth == 1:
		# strings were earlier wrapped in lists, now unwrap
		text = text[0]
	return [text, text_sources]


def text_from_cur(ref, textCur, context):
	"""
	Take a parsed ref and DB cursor of texts and construct a text to return out of what's available.
	Merges text fragments when necessary so that the final version has maximum text.
	"""
	versions = []
	versionTitles = []
	versionSources = []
	versionStatuses = []
	# does this ref refer to a range of text
	is_range = ref["sections"] != ref["toSections"]

	for t in textCur:
		try:
			text = t['chapter'][0] if len(ref["sectionNames"]) > 1 else t['chapter']
			if text == "" or text == []:
				continue
			if len(ref['sections']) < len(ref['sectionNames']) or context == 0 and not is_range:
				sections = ref['sections'][1:]
				if len(ref["sectionNames"]) == 1 and context == 0:
					sections = ref["sections"]
			else:
				# include surrounding text
				sections = ref['sections'][1:-1]
			# dive down into text until the request segment is found
			for i in sections:
				text = text[int(i) - 1]
			if is_range and context == 0:
				start = ref["sections"][-1] - 1
				end = ref["toSections"][-1]
				text = text[start:end]
			versions.append(text)
			versionTitles.append(t.get("versionTitle", ""))
			versionSources.append(t.get("versionSource", ""))
			versionStatuses.append(t.get("status", "none"))
		except IndexError:
			# this happens when t doesn't have the text we're looking for
			pass

	if list_depth(versions) == 1:
		while '' in versions:
			versions.remove('')

	if len(versions) == 0:
		ref['text'] = "" if context == 0 else []

	elif len(versions) == 1:
		ref['text'] = versions[0]
		ref['versionTitle'] = versionTitles[0]
		ref['versionSource'] = versionSources[0]
		ref['versionStatus'] = versionStatuses[0]

	elif len(versions) > 1:
		ref['text'], ref['sources'] = merge_translations(versions, versionTitles)
		if len([x for x in set(ref['sources'])]) == 1:
			# if sources only lists one title, no merge acually happened
			ref['versionTitle'] = ref['sources'][0]
			ref['versionSource'] = versionSources[versionTitles.index(ref['sources'][0])]
			ref['versionStatus'] = versionStatuses[versionTitles.index(ref['sources'][0])]
			del ref['sources']

	return ref


def get_text(ref, context=1, commentary=True, version=None, lang=None, pad=True):
	"""
	Take a string reference to a segment of text and return a dictionary including
	the text and other info.
		* 'context': how many levels of depth above the request ref should be returned.
	  		e.g., with context=1, ask for a verse and receive its surrounding chapter as well.
	  		context=0 gives just what is asked for.
		* 'commentary': whether or not to search for and return connected texts as well.
		* 'version' + 'lang': use to specify a particular version of a text to return.
	"""
	r = parse_ref(ref, pad=pad)
	if "error" in r:
		return r

	if is_spanning_ref(r):
		# If ref spans sections, call get_text for each section
		return get_spanning_text(r)

	if len(r["sections"]):
		skip = r["sections"][0] - 1
		limit = 1
		chapter_slice = {"_id": 0} if len(r["sectionNames"]) == 1 else {"_id": 0, "chapter": {"$slice": [skip,limit]}}
	else:
		chapter_slice = {"_id": 0}

	textCur = heCur = None
	# pull a specific version of text
	if version and lang == "en":
		textCur = db.texts.find({"title": r["book"], "language": lang, "versionTitle": version}, chapter_slice)

	elif version and lang == "he":
		heCur = db.texts.find({"title": r["book"], "language": lang, "versionTitle": version}, chapter_slice)

	# If no criteria set above, pull all versions,
	# Prioritize first according to "priority" field (if present), then by oldest text first
	# Order here will determine which versions are used in case of a merge
	textCur = textCur or db.texts.find({"title": r["book"], "language": "en"}, chapter_slice).sort([["priority", -1], ["_id", 1]])
	heCur   = heCur   or db.texts.find({"title": r["book"], "language": "he"}, chapter_slice).sort([["priority", -1], ["_id", 1]])

	# Extract / merge relevant text. Pull Hebrew from a copy of r first, since text_from_cur alters r
	heRef = text_from_cur(copy.deepcopy(r), heCur, context)
	r = text_from_cur(r, textCur, context)

	# Add fields pertaining the the Hebrew text under different field names
	r["he"]              = heRef.get("text") or []
	r["heVersionTitle"]  = heRef.get("versionTitle", "")
	r["heVersionSource"] = heRef.get("versionSource", "")
	r["heVersionStatus"] = heRef.get("versionStatus", "")
	if "sources" in heRef:
		r["heSources"] = heRef.get("sources")

	# find commentary on this text if requested
	if commentary:		
		searchRef = norm_ref(ref, pad=True, context=context)
		links = get_links(searchRef)
		r["commentary"] = links if "error" not in links else []

		# get list of available versions of this text
		# but only if you care enough to get commentary also (hack)
		r["versions"] = get_version_list(ref)

	# use shorthand if present, masking higher level sections
	if "shorthand" in r:
		r["book"] = r["shorthand"]
		d = r["shorthandDepth"]
		for key in ("sections", "toSections", "sectionNames"):
			r[key] = r[key][d:]

	# replace ints with daf strings (3->"2a") if text is Talmud or commentary on Talmud
	if r["type"] == "Talmud" or r["type"] == "Commentary" and r["commentaryCategories"][0] == "Talmud":
		daf = r["sections"][0]
		r["sections"] = [section_to_daf(daf)] + r["sections"][1:]
		r["title"] = r["book"] + " " + r["sections"][0]
		if "heTitle" in r:
			r["heBook"] = r["heTitle"]
			r["heTitle"] = r["heTitle"] + " " + section_to_daf(daf, lang="he")
		if r["type"] == "Commentary" and len(r["sections"]) > 1:
			r["title"] = "%s Line %d" % (r["title"], r["sections"][1])
		if "toSections" in r: 
			r["toSections"] = [r["sections"][0]] + r["toSections"][1:]

	elif r["type"] == "Commentary":
		d = len(r["sections"]) if len(r["sections"]) < 2 else 2
		r["title"] = r["book"] + " " + ":".join(["%s" % s for s in r["sections"][:d]])

	return r


def is_spanning_ref(pRef):
	"""
	Returns True if the parsed ref (pRef) spans across text sections.
	(where "section" is the second lowest segment level, e.g., "Chapter", "Daf")
	Shabbat 13a-b - True, Shabbat 13a:3-14 - False
	Job 4:3-5:3 - True, Job 4:5-18 - False
	"""
	depth = pRef["textDepth"]
	if depth == 1:
		# text of depth 1 can't be spanning
		return False

	if len(pRef["sections"]) == 0:
		# can't be spanning if no sections set
		return False

	if len(pRef["sections"]) <= depth - 2:
		point = len(pRef["sections"]) - 1
	else:
		point = depth - 2

	if pRef["sections"][point] == pRef["toSections"][point]:
		return False

	return True


def get_spanning_text(pRef):
	"""
	Gets text for a ref that spans across text sections.

	TODO refactor to handle commentary on spanning refs
	TODO properly track version names and lists which may differ across sections
	"""
	refs = split_spanning_ref(pRef)
	result, text, he = {}, [], []
	for ref in refs:
		result = get_text(ref, context=0, commentary=False)
		text.append(result["text"])
		he.append(result["he"])

	result["text"] = text
	result["he"] = he
	result["spanning"] = True
	result.update(pRef)
	return result


def split_spanning_ref(pRef):
	"""
	Returns a list of refs that do not span sections which corresponds
	to the spanning ref in pRef.
	Shabbat 13b-14b -> ["Shabbat 13b", "Shabbat 14a", "Shabbat 14b"]

	TODO This currently ignores any segment level specifications
	e.g, Job 4:10-6:4 -> ["Job 4", "Job 5", "Job 6"]
	"""
	depth = pRef["textDepth"]
	if depth == 1:
		return [pRef["ref"]]

	start, end = pRef["sections"][depth-2], pRef["toSections"][depth-2]

	refs = []

	# build a parsed ref for each new ref
	# this ignores segment level specfications, which are added back later
	for n in range(start, end+1):
		section_pRef = copy.deepcopy(pRef)
		section_pRef["sections"] = pRef["sections"][0:depth-1]
		section_pRef["sections"][-1] = n
		section_pRef["toSections"] = section_pRef["sections"]
		refs.append(make_ref(section_pRef))

	if len(pRef["sections"]) == depth:
		# add specificity only if it exists in the original ref

		# add segment specificity to beginning
		last_segment = get_segment_count_for_ref(refs[0])
		refs[0] = "%s:%d-%d" % (refs[0], pRef["sections"][-1], last_segment)

		# add segment specificity to end
		refs[-1] = "%s:1-%d" % (refs[-1], pRef["toSections"][-1])

	return refs


def list_refs_in_range(ref):
	"""
	Returns a list of refs corresponding to each point in the range of refs
	"""
	pRef = parse_ref(ref)
	if "error" in pRef:
		return pRef

	results = []
	sections, toSections = pRef["sections"], pRef["toSections"]
	pRef["sections"] = pRef["toSections"] = sections[:]

	for section in range(sections[-1], toSections[-1]+1):
		pRef["sections"][-1] = section
		results.append(make_ref(pRef))

	return results


def get_segment_count_for_ref(ref):
	"""
	Returns the number of segments stored in the DB
	for ref.
	a.k.a., return the number of verses for a chapter.
	"""
	text = get_text(ref, commentary=False)
	return max(len(text["text"]), len(text["he"]))


def get_version_list(ref):
	"""
	Returns a list of available text versions matching 'ref'
	"""
	pRef = parse_ref(ref)
	if "error" in pRef:
		return []

	skip = pRef["sections"][0] - 1 if len(pRef["sections"]) else 0
	limit = 1
	versions = db.texts.find({"title": pRef["book"]}, {"chapter": {"$slice": [skip, limit]}})

	vlist = []
	for v in versions:
		text = v['chapter']
		for i in [0] + pRef["sections"][1:]:
			try:
				text = text[i]
			except (IndexError, TypeError):
				text = None
				continue
		if text:
			vlist.append({"versionTitle": v["versionTitle"], "language": v["language"]})

	return vlist


def make_ref_re(ref):
	"""
	Returns a string for a Regular Expression which will find any refs that match
	'ref' exactly, or more specificly than 'ref'
	E.g., "Genesis 1" yields an RE that match "Genesis 1" and "Genesis 1:3"
	"""
	ref  = norm_ref(ref)
	pRef = parse_ref(ref)
	patterns = []
	refs = list_refs_in_range(ref) if "-" in ref else [ref]

	for r in refs:
		sections = re.sub("^%s" % pRef["book"], '', r) 
		patterns.append("%s$" % sections)   # exact match
		patterns.append("%s:" % sections)   # more granualar, exact match followed by :
		patterns.append("%s \d" % sections) # extra granularity following space 

	return "^%s(%s)" % (pRef["book"], "|".join(patterns))


def get_links(ref, with_text=True):
	"""
	Return a list links tied to 'ref'.
	If with_text, retrieve texts for each link.
	"""
	links = []
	nRef = norm_ref(ref)
	reRef = make_ref_re(nRef)

	# for storing all the section level texts that need to be looked up
	texts = {}

	linksCur = db.links.find({"refs": {"$regex": reRef}})
	# For all links that mention ref (in any position)
	for link in linksCur:
		# each link contins 2 refs in a list
		# find the position (0 or 1) of "anchor", the one we're getting links for
		pos = 0 if re.match(reRef, link["refs"][0]) else 1
		com = format_link_for_client(link, nRef, pos, with_text=False)

		# Rather than getting text with each link, walk through all links here,
		# caching text so that redudant DB calls can be minimized
		if with_text and "error" not in com:
			top_ref = top_section_ref(com["ref"])
			pRef = parse_ref(com["ref"])

			# Lookup and save top level text, only if we haven't already
			if top_ref not in texts:
				texts[top_ref] = get_text(top_ref, context=0, commentary=False, pad=False)

			sections, toSections = pRef["sections"][1:],  pRef["toSections"][1:]
			com["text"] = grab_section_from_text(sections, texts[top_ref]["text"], toSections)
			com["he"]   = grab_section_from_text(sections, texts[top_ref]["he"],   toSections)

		links.append(com)

	return links


def format_link_for_client(link, ref, pos, with_text=True):
	"""
	Returns an object that represents 'link' in the format expected by the reader client.
	TODO - much of this format is legacy and should be cleaned up.
	"""
	com = {}

	# The text we're asked to get links to
	anchorRef = parse_ref(link["refs"][pos])
	if "error" in anchorRef:
		return {"error": "Error parsing %s: %s" % (link["refs"][pos], anchorRef["error"])}

	# The link we found to anchorRef
	linkRef = parse_ref( link[ "refs" ][ ( pos + 1 ) % 2 ] )
	if "error" in linkRef:
		return {"error": "Error parsing %s: %s" % (link["refs"][(pos + 1) % 2], linkRef["error"])}

	com["_id"]           = str(link["_id"])
	com["category"]      = linkRef["type"]
	com["type"]          = link["type"]
	com["ref"]           = linkRef["ref"]
	com["anchorRef"]     = make_ref(anchorRef)
	com["sourceRef"]     = make_ref(linkRef)
	com["anchorVerse"]   = anchorRef["sections"][-1]
	com["commentaryNum"] = linkRef["sections"][-1] if linkRef["type"] == "Commentary" else 0
	com["anchorText"]    = link["anchorText"] if "anchorText" in link else ""

	if with_text:
		text             = get_text(linkRef["ref"], context=0, commentary=False)
		com["text"]      = text["text"] if text["text"] else ""
		com["he"]        = text["he"] if text["he"] else ""

	# strip redundant verse ref for commentators
	if com["category"] == "Commentary":
		# if the ref we're looking for appears exactly in the commentary ref, strip redundant info
		if ref in linkRef["ref"]:
			com["commentator"] = linkRef["commentator"]
			com["heCommentator"] = linkRef["heCommentator"] if "heCommentator" in linkRef else com["commentator"]
		else:
			com["commentator"] = linkRef["ref"]
			com["heCommentator"] = linkRef["heTitle"] if "heTitle" in linkRef else com["commentator"]
	else:
		com["commentator"] = linkRef["book"]
		com["heCommentator"] = linkRef["heTitle"] if "heTitle" in linkRef else com["commentator"]

	if "heTitle" in linkRef:
		com["heTitle"] = linkRef["heTitle"]

	return com


def get_notes(ref, public=True, uid=None, pad=True, context=0):
	"""
	Returns a list of notes related to ref.
	If public, include any public note.
	If uid is set, return private notes of uid.
	"""
	links = []
	nRef = norm_ref(ref, pad=pad, context=context)
	if not nRef:
		return []
	reRef = make_ref_re(nRef)

	if public and uid:
		query = {"ref": {"$regex": reRef}, "$or": [{"public": True}, {"owner": uid}]}
	elif public:
		query = {"ref": {"$regex": reRef}, "public": True}
	elif uid:
		query = {"ref": {"$regex": reRef}, "owner": uid}


	# Find any notes associated with this ref
	notes = db.notes.find(query)
	for note in notes:
		com = format_note_for_client(note)
		if note["owner"] != uid:
			com["text"] = com["commentator"] + " - " + com["text"] if com["commentator"] else com["text"]
			com["commentator"] = user_link(note["owner"])
		links.append(com)

	return links


def format_note_for_client(note):
	"""
	Returns an object that represents note in the format expected by the reader client,
	matching the format of links, which are currently handled together.
	"""
	com = {}
	anchorRef = parse_ref(note["ref"])

	com["commentator"] = note["title"]
	com["category"]    = "Notes"
	com["type"]        = "note"
	com["owner"]       = note["owner"]
	com["_id"]         = str(note["_id"])
	com["anchorRef"]   = note["ref"]
	com["anchorVerse"] = anchorRef["sections"][-1]
	com["anchorText"]  = note["anchorText"] if "anchorText" in note else ""
	com["text"]        = note["text"]
	com["public"]      = note["public"] if "public" in note else False

	return com


def get_he_mishna_pehmem_regex(title):
	exp = ur"""(?:^|\s)								# beginning or whitespace
		(?P<title>{0})								# title
		\s+											# a space
		(?:
		    \u05e4(?:"|\u05f4|'')?                  # Peh (for 'perek') maybe followed by a quote of some sort
		    |\u05e4\u05e8\u05e7\s*                  # or 'perek' spelled out, followed by space
		)
		(?P<num1>									# the first number (1 of 3 styles, below)
			\p{{Hebrew}}['\u05f3]					# (1: ') single letter, followed by a single quote or geresh
			|(?=\p{{Hebrew}}+(?:"|\u05f4|'')\p{{Hebrew}}) # (2: ") Lookahead:  At least one letter, followed by double-quote, two single quotes, or gershayim, followed by  one letter
				\u05ea*(?:"|\u05f4|'')?				# Many Tavs (400), maybe dbl quote
				[\u05e7-\u05ea]?(?:"|\u05f4|'')?	# One or zero kuf-tav (100-400), maybe dbl quote
				[\u05d8-\u05e6]?(?:"|\u05f4|'')?	# One or zero tet-tzaddi (9-90), maybe dbl quote
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)															#
			|(?=\p{{Hebrew}})						# (3: no punc) Lookahead: at least one Hebrew letter
				\u05ea*								# Many Tavs (400)
				[\u05e7-\u05ea]?					# One or zero kuf-tav (100-400)
				[\u05d8-\u05e6]?					# One or zero tet-tzaddi (9-90)
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)
		)											# end of the num1 group
		(?:\s+[,:]?\s*|\s*[,:]?\s+|\s*[,:]\s*)		# some type of delimiter - colon, comma, or space, maybe a combo
		(?:
			(?:\u05de\u05e9\u05e0\u05d4\s)			# Mishna spelled out, with a space after
			|(?:\u05de(?:"|\u05f4|'')?)				# or Mem (for 'mishna') maybe followed by a quote of some sort
		)
		(?P<num2>									# second number
			\p{{Hebrew}}['\u05f3]					# (1: ') single letter, followed by a single quote or geresh
			|(?=\p{{Hebrew}}+(?:"|\u05f4|'')\p{{Hebrew}}) # (2: ") Lookahead:  At least one letter, followed by double-quote, two single quotes, or gershayim, followed by  one letter
				\u05ea*(?:"|\u05f4|'')?				# Many Tavs (400), maybe dbl quote
				[\u05e7-\u05ea]?(?:"|\u05f4|'')?	# One or zero kuf-tav (100-400), maybe dbl quote
				[\u05d8-\u05e6]?(?:"|\u05f4|'')?	# One or zero tet-tzaddi (9-90), maybe dbl quote
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)															#
			|(?=\p{{Hebrew}})						# (3: no punc) Lookahead: at least one Hebrew letter
				\u05ea*								# Many Tavs (400)
				[\u05e7-\u05ea]?					# One or zero kuf-tav (100-400)
				[\u05d8-\u05e6]?					# One or zero tet-tzaddi (9-90)
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)
		)											# end of the num2 group
		(?=\s|$)									# look ahead - either a space or the end of the string
	""".format(regex.escape(title))
	return regex.compile(exp, regex.VERBOSE)


def get_he_mishna_peh_regex(title):
	exp = ur"""(?:^|\s)								# beginning or whitespace
		(?P<title>{0})								# title
		\s+											# a space
		(?:
		    \u05e4(?:"|\u05f4|'')?                  # Peh (for 'perek') maybe followed by a quote of some sort
		    |\u05e4\u05e8\u05e7\s*                  # or 'perek' spelled out, followed by space
		)
		(?P<num1>									# the first number (1 of 3 styles, below)
			\p{{Hebrew}}['\u05f3]					# (1: ') single letter, followed by a single quote or geresh
			|(?=\p{{Hebrew}}+(?:"|\u05f4|'')\p{{Hebrew}}) # (2: ") Lookahead:  At least one letter, followed by double-quote, two single quotes, or gershayim, followed by  one letter
				\u05ea*(?:"|\u05f4|'')?				# Many Tavs (400), maybe dbl quote
				[\u05e7-\u05ea]?(?:"|\u05f4|'')?	# One or zero kuf-tav (100-400), maybe dbl quote
				[\u05d8-\u05e6]?(?:"|\u05f4|'')?	# One or zero tet-tzaddi (9-90), maybe dbl quote
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)															#
			|(?=\p{{Hebrew}})						# (3: no punc) Lookahead: at least one Hebrew letter
				\u05ea*								# Many Tavs (400)
				[\u05e7-\u05ea]?					# One or zero kuf-tav (100-400)
				[\u05d8-\u05e6]?					# One or zero tet-tzaddi (9-90)
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)
		)											# end of the num1 group
		(?=\s|$)									# look ahead - either a space or the end of the string
	""".format(regex.escape(title))
	return regex.compile(exp, regex.VERBOSE)


def get_he_tanach_ref_regex(title):
	"""
	todo: this is matching "שם" in the num1 group, because the final letters are interspersed in the range.
	"""
	exp = ur"""(?:^|\s)								# beginning or whitespace
		(?P<title>{0})								# title
		\s+											# a space
		(?P<num1>									# the first number (1 of 3 styles, below)
			\p{{Hebrew}}['\u05f3]					# (1: ') single letter, followed by a single quote or geresh
			|(?=\p{{Hebrew}}+(?:"|\u05f4|'')\p{{Hebrew}}) # (2: ") Lookahead:  At least one letter, followed by double-quote, two single quotes, or gershayim, followed by  one letter
				\u05ea*(?:"|\u05f4|'')?				# Many Tavs (400), maybe dbl quote
				[\u05e7-\u05ea]?(?:"|\u05f4|'')?	# One or zero kuf-tav (100-400), maybe dbl quote
				[\u05d8-\u05e6]?(?:"|\u05f4|'')?	# One or zero tet-tzaddi (9-90), maybe dbl quote
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)															#
			|(?=\p{{Hebrew}})						# (3: no punc) Lookahead: at least one Hebrew letter
				\u05ea*								# Many Tavs (400)
				[\u05e7-\u05ea]?					# One or zero kuf-tav (100-400)
				[\u05d8-\u05e6]?					# One or zero tet-tzaddi (9-90)
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)
		)											# end of the num1 group
		(?:\s+[,:]?\s*|\s*[,:]?\s+|\.|\s*[,:]\s*|$)	# some type of delimiter - colon, comma, or space, maybe a combo, a single period, or else maybe ref-end
		(?:											# second number group - optional
			(?P<num2>								# second number
				\p{{Hebrew}}['\u05f3]				# (1: ') single letter, followed by a single quote or geresh
				|(?=\p{{Hebrew}}+(?:"|\u05f4|'')\p{{Hebrew}}) # (2: ") Lookahead:  At least one letter, followed by double-quote, two single quotes, or gershayim, followed by  one letter
					\u05ea*(?:"|\u05f4|'')?			# Many Tavs (400), maybe dbl quote
					[\u05e7-\u05ea]?(?:"|\u05f4|'')?	# One or zero kuf-tav (100-400), maybe dbl quote
					[\u05d8-\u05e6]?(?:"|\u05f4|'')?	# One or zero tet-tzaddi (9-90), maybe dbl quote
					[\u05d0-\u05d8]?				# One or zero alef-tet (1-9)															#
				|(?=\p{{Hebrew}})					# (3: no punc) Lookahead: at least one Hebrew letter
					\u05ea*							# Many Tavs (400)
					[\u05e7-\u05ea]?				# One or zero kuf-tav (100-400)
					[\u05d8-\u05e6]?				# One or zero tet-tzaddi (9-90)
					[\u05d0-\u05d8]?				# One or zero alef-tet (1-9)
			)?										# end of the num2 group
			(?=\s|$)								# look ahead - either a space or the end of the string
		)?
	""".format(regex.escape(title))
	return regex.compile(exp, regex.VERBOSE)


def get_he_talmud_ref_regex(title):
	exp = ur"""(?:^|\s)								# beginning or whitespace
		(?P<title>{0})								# title
		\s+											# a space
		(\u05d3[\u05e3\u05e4\u05f3']\s+)?			# Daf, spelled with peh, peh sofit, geresh, or single quote
		(?P<num1>									# the first number (1 of 3 styles, below)
			\p{{Hebrew}}['\u05f3]					# (1: ') single letter, followed by a single quote or geresh
			|(?=\p{{Hebrew}}+(?:"|\u05f4|'')\p{{Hebrew}}) # (2: ") Lookahead:  At least one letter, followed by double-quote, two single quotes, or gershayim, followed by  one letter
				\u05ea*(?:"|\u05f4|'')?				# Many Tavs (400), maybe dbl quote
				[\u05e7-\u05ea]?(?:"|\u05f4|'')?	# One or zero kuf-tav (100-400), maybe dbl quote
				[\u05d8-\u05e6]?(?:"|\u05f4|'')?	# One or zero tet-tzaddi (9-90), maybe dbl quote
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)
			|(?=\p{{Hebrew}})						# (3: no punc) Lookahead: at least one Hebrew letter
				\u05ea*								# Many Tavs (400)
				[\u05e7-\u05ea]?					# One or zero kuf-tav (100-400)
				[\u05d8-\u05e6]?					# One or zero tet-tzaddi (9-90)
				[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)
		)											# end of the num1 group
		(?P<amud>									# amud indicator
			[.:]									# a period or a colon, for a or b
			|[,\s]+			    					# or some space/comma
			[\u05d0\u05d1]							# followed by an aleph or bet
		)?											# end of daf indicator
		(?:\s|$)									# space or end of string
	""".format(regex.escape(title))
	return regex.compile(exp, regex.VERBOSE)


def parse_he_ref(ref, pad=True):
	"""
	Decide what kind of reference we're looking at, then parse it to its parts
	"""
	#These refs should be cached, as well
	#if ref in parsed: 	# and pad?
	#	return copy.deepcopy(parsed[ref])

	#logger.debug(ref)

	titles = get_titles_in_text(ref, "he")

	if not titles:
		logger.warning("parse_he_ref(): No titles found in: %s", ref)
		return {"error": "No titles found in: %s" % ref}

	he_title = max(titles, key=len)  # Assuming that longest title is the best
	index = get_he_index(he_title)

	if "error" in index:
		logger.warning("parse_he_ref(): Error in index fo: %s", he_title)
		return index

	cat = index["categories"][0]

	if cat == "Tanach":
		reg = get_he_tanach_ref_regex(he_title)
		match = reg.search(ref)
	elif cat == "Mishnah":
		reg = get_he_mishna_pehmem_regex(he_title)
		match = reg.search(ref)
		if not match:
			reg = get_he_mishna_peh_regex(he_title)
			match = reg.search(ref)
		if not match:
			reg = get_he_tanach_ref_regex(he_title)
			match = reg.search(ref)
	elif cat == "Talmud":
		reg = get_he_mishna_pehmem_regex(he_title) #try peh-mem form first, since it's stricter
		match = reg.search(ref)
		if match: #if it matches, we need to force a mishnah result
			he_title = u"משנה" + " " + he_title
			index = get_he_index(he_title)
		else:
			reg = get_he_talmud_ref_regex(he_title)
			match = reg.search(ref)
	else:  # default
		return {"error": "No support for Hebrew " + cat + " references: " + ref}

	if not match:
		logger.warning("parse_he_ref(): Can not match: %s", ref)
		return {"error": "Match Miss: %s" % ref}

	eng_ref = index["title"]
	gs = match.groupdict()

	if u"שם" in gs.get('num1'): # todo: handle ibid refs or fix regex so that this doesn't pass
		return {"error": "%s not supported" % u"שם"}

	if gs.get('num1') is not None:
		gs['num1'] = decode_hebrew_numeral(gs['num1'])
		eng_ref += "." + str(gs['num1'])

	if gs.get('num2') is not None:
		gs['num2'] = decode_hebrew_numeral(gs['num2'])
		eng_ref += "." + str(gs['num2'])
	elif gs.get('amud') is not None:
		if u"\u05d0" in gs['amud'] or "." in gs['amud']:
			eng_ref += "a"
		elif u"\u05d1" in gs['amud'] or ":" in gs['amud']:
			eng_ref += "b"


	logger.debug("parse_he_ref: " + ref + " -> " + eng_ref)
	return parse_ref(eng_ref, pad)


def memoize_parse_ref(func):
	"""
	Decorator for parse_ref to cache results in memory
	Appends '|NOPAD' to the ref used as the dictionary key for 'parsed' to cache
	results that have pad=False.
	"""
	def memoized_parse_ref(ref, pad=True):
		try:
			ref = ref.strip()
			if is_hebrew(ref):
				ref = ref.replace(u"–", "-").replace("_", " ")  # don't replace : in Hebrew, where it can indicate amud
			else:
				ref = ref.decode('utf-8').replace(u"–", "-").replace(":", ".").replace("_", " ")
		except UnicodeEncodeError, e:
			return {"error": "UnicodeEncodeError: %s" % e}
		except AttributeError, e:
			return {"error": "AttributeError: %s" % e}

		try:
			# capitalize first letter (don't title case all to avoid e.g., "Song Of Songs")
			ref = ref[0].upper() + ref[1:]
		except IndexError:
			pass

		#parsed is the cache for parse_ref
		global parsed
		if ref in parsed and pad:
			return copy.copy(parsed[ref])
		if "%s|NOPAD" % ref in parsed and not pad:
			return copy.copy(parsed["%s|NOPAD" % ref])

		pRef = func(ref, pad)
		if pad:
			parsed[ref] = copy.copy(pRef)
		else:
			parsed["%s|NOPAD" % ref] = copy.copy(pRef)

		return pRef
	return memoized_parse_ref


@memoize_parse_ref
def parse_ref(ref, pad=True):
	"""
	Take a string reference (e.g. 'Job.2:3-3:1') and returns a parsed dictionary of its fields

	If pad is True, ref sections will be padded with 1's until the sections are at least within one
	level from the depth of the text.

	Returns:
		* ref - the original string reference
		* book - a string name of the text
		* sectionNames - an array of strings naming the kinds of sections in this text (Chapter, Verse)
		* textDepth - an integer denote the number of sections named in sectionNames
		* sections - an array of ints giving the requested sections numbers
		* toSections - an array of ints giving the requested sections at the end of a range
		* next, prev - an dictionary with the ref and labels for the next and previous sections
		* categories - an array of categories for this text
		* type - the highest level category for this text

	todo: handle comma in refs like: "Me'or Einayim, 24"
	"""
#	logger.debug("In parse_ref. Ref: %s", ref)
	if is_hebrew(ref):
		return parse_he_ref(ref, pad)

	pRef = {}

	# Split into range start and range end (if any)
	toSplit = ref.split("-")
	if len(toSplit) > 2:
		pRef["error"] = "Couldn't understand ref (too many -'s)"
		return pRef

	toSplit = [s.strip() for s in toSplit]

	# Get book
	base = toSplit[0]
	bcv = base.split(".") # bcv stands for book, chapter, verse, from a time when all we had was tanakh
	# Normalize Book
	pRef["book"] = bcv[0].replace("_", " ")

	# handle space between book and sections (Genesis 4:5) as well as . (Genesis.4.3)
	if re.match(r".+ \d+[ab]?", pRef["book"]):
		p = pRef["book"].rfind(" ")
		bcv.insert(1, pRef["book"][p+1:])
		pRef["book"] = pRef["book"][:p]

	# Try looking for a stored map (shorthand)
	shorthand = db.index.find_one({"maps": {"$elemMatch": {"from": pRef["book"]}}})
	if shorthand:
		for i in range(len(shorthand["maps"])):
			if shorthand["maps"][i]["from"] == pRef["book"]:
				# replace the shorthand in ref with its mapped value and recur
				to = shorthand["maps"][i]["to"]
				if ref != to:
					ref = ref.replace(pRef["book"]+" ", to + ".")
					ref = ref.replace(pRef["book"], to)
				parsedRef = parse_ref(ref)
				d = len(parse_ref(to, pad=False)["sections"])
				parsedRef["shorthand"] = pRef["book"]
				parsedRef["shorthandDepth"] = d
				return parsedRef

	# Find index record or book
	index = get_index(pRef["book"])

	if "error" in index:
		return index

	if index["categories"][0] == "Commentary" and "commentaryBook" not in index:
		return {"error": "Please specify a text that %s comments on." % index["title"]}

	pRef["book"] = index["title"]
	pRef["type"] = index["categories"][0]
	del index["title"]
	pRef.update(index)

	# Special Case Talmud or commentaries on Talmud from here
	if pRef["type"] == "Talmud" or pRef["type"] == "Commentary" and "commentaryCategories" in index and index["commentaryCategories"][0] == "Talmud":
		pRef["bcv"] = bcv
		pRef["ref"] = ref
		result = subparse_talmud(pRef, index, pad=pad)
		result["ref"] = make_ref(pRef)
		return result

	# Parse section numbers
	try:
		pRef["sections"] = []
		# Book only
		if len(bcv) == 1 and pad:
			pRef["sections"] = [1 for i in range(len(pRef["sectionNames"]) - 1)]
		else:
			for i in range(1, len(bcv)):
				pRef["sections"].append(int(bcv[i]))

		# Pad sections with 1's, so e,g. "Mishneh Torah 4:3" points to "Mishneh Torah 4:3:1"
		if pad:
			for i in range(len(pRef["sections"]), len(pRef["sectionNames"]) -1):
				pRef["sections"].append(1)

		pRef["toSections"] = pRef["sections"][:]


		# handle end of range (if any)
		if len(toSplit) > 1:
			cv = toSplit[1].split(".")
			delta = len(pRef["sections"]) - len(cv)
			for i in range(delta, len(pRef["sections"])):
				pRef["toSections"][i] = int(cv[i - delta])
	except ValueError:
		parsed[ref] = {"error": "Couldn't understand text sections: %s" % ref}
		return parsed[ref]

	# give error if requested section is out of bounds
	if "length" in index and len(pRef["sections"]):
		if pRef["sections"][0] > index["length"]:
			result = {"error": "%s only has %d %ss." % (pRef["book"], index["length"], pRef["sectionNames"][0])}
			return result

	if pRef["categories"][0] == "Commentary" and "commentaryBook" not in pRef:
		pRef["ref"] = pRef["book"]
		return pRef

	pRef["next"] = next_section(pRef)
	pRef["prev"] = prev_section(pRef)
	pRef["ref"] = make_ref(pRef)

#	logger.debug(pRef)

	return pRef


def subparse_talmud(pRef, index, pad=True):
	"""
	Special sub method for parsing Talmud references,
	allowing for Daf numbering "2a", "2b", "3a" etc.

	This function returns the first section as an int which corresponds
	to how the text is stored in the DB,
	e.g. 2a = 3, 2b = 4, 3a = 5.

	for a sides: (daf * 2) - 1 = DB index
	for b sides: (daf * 2) = DB index

	get_text will transform these ints back into daf strings
	before returning to the client.
	"""
	toSplit = pRef["ref"].split("-")
	bcv = pRef["bcv"]
	del pRef["bcv"]

	pRef["sections"] = []
	if len(bcv) == 1 and pad:
		# Set the daf to 2a if pad and none specified
		daf = 2 if "Bavli" in pRef["categories"] else 1
		amud = "a"
		section = 3 if "Bavli" in pRef["categories"] else 1
		pRef["sections"].append(section)

	elif len(bcv) > 1:
		daf = bcv[1]
		if not re.match("\d+[ab]?", daf):
			pRef["error"] = "Couldn't understand Talmud Daf reference: %s" % daf
			return pRef
		try:
			if daf[-1] in ["a", "b"]:
				amud = daf[-1]
				daf = int(daf[:-1])
			else:
				amud = "a"
				daf = int(daf)
		except ValueError:
			return {"error": "Couldn't understand daf: %s" % pRef["ref"]}

		if "length" in index and daf > index["length"]:
			pRef["error"] = "%s only has %d dafs." % (pRef["book"], index["length"])
			return pRef

		chapter = daf * 2
		if amud == "a": chapter -= 1

		pRef["sections"] = [chapter]
		pRef["toSections"] = [chapter]

		# line numbers or line number and comment numbers specified
		if len(bcv) > 2:
			pRef["sections"].extend(map(int, bcv[2:]))
			pRef["toSections"].extend(map(int, bcv[2:]))

	if pad:
		# add additional padding if needed
		# (e.g change Rashi on Shabbat 2a -> Rashi on Shabbat 2a:1)
		for i in range(pRef["textDepth"] - len(pRef["sections"]) - 1):
			pRef["sections"].append(1)

	pRef["toSections"] = pRef["sections"][:]

	if len(pRef["sections"]) == 0:
		return pRef

	# Handle range if specified
	if len(toSplit)	== 2:
		toSections = toSplit[1].replace(r"[ :]", ".").split(".")

		# 'Shabbat 23a-b'
		if toSections[0] == 'b':
			toSections[0] = pRef["sections"][0] + 1

		# 'Shabbat 24b-25a'
		elif re.match("\d+[ab]", toSections[0]):
			toSections[0] = daf_to_section(toSections[0])
		pRef["toSections"] = [int(s) for s in toSections]

		delta = len(pRef["sections"]) - len(pRef["toSections"])
		for i in range(delta -1, -1, -1):
			pRef["toSections"].insert(0, pRef["sections"][i])

	# Set next daf, or next line for commentary on daf
	if "length" not in index or pRef["sections"][0] < index["length"] * 2: # 2 because talmud length count dafs not amuds
		if pRef["type"] == "Talmud":
			nextDaf = section_to_daf(pRef["sections"][0] + 1)
			pRef["next"] = "%s %s" % (pRef["book"], nextDaf)
		elif pRef["type"] == "Commentary":
			daf = section_to_daf(pRef["sections"][0])
			line = pRef["sections"][1] if len(pRef["sections"]) > 1 else 1
			pRef["next"] = "%s %s:%d" % (pRef["book"], daf, line + 1)

	# Set previous daf, or previous line for commentary on daf
	first_page = 3 if "Bavli" in pRef["categories"] else 1 # bavli starts on 2a (3), Yerushalmi on 1a (1)
	if pRef["type"] == "Talmud" and pRef["sections"][0] > first_page:
		prevDaf = section_to_daf(pRef["sections"][0] - 1)
		pRef["prev"] = "%s %s" % (pRef["book"], prevDaf)
	elif pRef["type"] == "Commentary":
		daf = section_to_daf(pRef["sections"][0])
		line = pRef["sections"][1] if len(pRef["sections"]) > 1 else 1
		if line > 1:
			pRef["prev"] = "%s %s:%d" % (pRef["book"], daf, line - 1)

	return pRef


def parse_daf_string(daf):
	"""
	Take a string representing a daf ('55', amud ('55b')
	or a line on a daf ('55b:2') and return of list parsing it in
	ints.

	'2a' -> [3], '2a:4' -> [3, 4]
	"""
	return []


def next_section(pRef):
	"""
	Returns a ref of the section after the one designated by pRef
	or the section that contains the segment designated by pRef.
	E.g, Genesis 2 -> Genesis 3
	"""
	# If this is a one section text there is no next section
	if pRef["textDepth"] == 1:
		return None

	# Trim sections to the length of section, not segments
	next = pRef["sections"][:pRef["textDepth"] - 1]
	if (len(next) == 0): # zero if sections is empty
		next = [1]

	if pRef["categories"][0] == "Commentary":
		text = get_text("%s.%s" % (pRef["commentaryBook"], ".".join([str(s) for s in next[:-1]])), False, 0)
		if "error" in text: return None
		length = max(len(text["text"]), len(text["he"]))

	# If this is the last section there is no next
	# Since 'length' only applies to top level, this only
	# works with text depth 2.
	if "length" in pRef and pRef["textDepth"] == 2 and next[0] >= pRef["length"]:
		return None

	# Increment the appropriate section
	if pRef["categories"][0] == "Commentary" and next[-1] == length:
		next[-2] = next[-2] + 1
		next[-1] = 1
	else:
		next[-1] = next[-1] + 1
	nextRef = "%s %s" % (pRef["book"], ".".join([str(s) for s in next]))

	return nextRef


def prev_section(pRef):
	"""
	Returns a ref of the section before the one designated by pRef.
	Returns None if this is the first section.
	E.g, Genesis 2 -> Genesis 3
	"""
	# If this is a one section text there is no prev section
	if len(pRef["sectionNames"]) == 1:
		return None

	# Trimmed to the length of sections, not segments
	prev = pRef["sections"][:len(pRef["sectionNames"]) - 1]
	if (len(prev) == 0):
		prev = pRef["sections"]

	# if this is not the first section
	if False not in [x==1 for x in prev]:
		return None

	if pRef["categories"][0] == "Commentary" and prev[-1] == 1:
		pSections = prev[:-1]
		pSections[-1] = pSections[-1] - 1 if pSections[-1] > 1 else 1
		prevText = get_text("%s.%s" % (pRef["commentaryBook"], ".".join([str(s) for s in pSections])), False, 0)
		if "error" in prevText: return None
		pLength = max(len(prevText["text"]), len(prevText["he"]))
		prev[-2] = prev[-2] - 1 if prev[-2] > 1 else 1
		prev[-1] = pLength
	else:
		prev[-1] = prev[-1] - 1 if prev[-1] > 1 else 1
	prevRef = "%s %s" % (pRef["book"], ".".join([str(s) for s in prev]))

	return prevRef


def daf_to_section(daf):
	"""
	Transforms a daf string (e.g., '4b') to its corresponding stored section number.
	"""
	amud = daf[-1]
	daf = int(daf[:-1])
	section = daf * 2
	if amud == "a": section -= 1
	return section


def section_to_daf(section, lang="en"):
	"""
	Transforms a section number to its corresponding daf string,
	in English or in Hebrew.
	"""
	section += 1
	daf = section / 2

	if lang == "en":
		if section > daf * 2:
			daf = "%db" % daf
		else:
			daf = "%da" % daf

	elif lang == "he":
		if section > daf * 2:
			daf = ("%s " % encode_hebrew_numeral(daf)) + u"\u05D1"
		else:
			daf = ("%s " % encode_hebrew_numeral(daf)) + u"\u05D0"

	return daf


def norm_ref(ref, pad=False, context=0):
	"""
	Returns a normalized string ref for 'ref' or False if there is an
	error parsing ref.
	* pad: whether to insert 1s to make the ref specfic to at least section level
		e.g.: "Genesis" --> "Genesis 1"
	* context: how many levels to 'zoom out' from the most specific possible ref
		e.g., with context=1, "Genesis 4:5" -> "Genesis 4"
	"""
	pRef = parse_ref(ref, pad=pad)
	if "error" in pRef:
		logger.error("norm_ref: Could not parse ref: %s - %s", ref, pRef['error'])
		return False
	if context:
		pRef["sections"] = pRef["sections"][:pRef["textDepth"]-context]
		pRef["toSections"] = pRef["sections"][:pRef["textDepth"]-context]

	return make_ref(pRef)


def make_ref(pRef):
	"""
	Returns a string ref which is the normalized form of the parsed dictionary 'pRef'
	"""
	if pRef["type"] == "Commentary" and "commentaryCategories" not in pRef:
		return pRef["book"]

	if pRef["type"] == "Talmud" or pRef["type"] == "Commentary" and pRef["commentaryCategories"][0] == "Talmud":
		talmud = True
		nref = pRef["book"]
		nref += " " + section_to_daf(pRef["sections"][0]) if len(pRef["sections"]) > 0 else ""
		nref += ":" + ":".join([str(s) for s in pRef["sections"][1:]]) if len(pRef["sections"]) > 1 else ""
	else:
		talmud = False
		nref = pRef["book"]
		sections = ":".join([str(s) for s in pRef["sections"]])
		if len(sections):
			nref += " " + sections

	for i in range(len(pRef["sections"])):
		if not pRef["sections"][i] == pRef["toSections"][i]:
			if i == 0 and pRef and talmud:
				nref += "-%s" % (":".join([str(s) for s in [section_to_daf(pRef["toSections"][0])] + pRef["toSections"][i+1:]]))
			else:
				nref += "-%s" % (":".join([str(s) for s in pRef["toSections"][i:]]))
			break

	return nref


def url_ref(ref):
	"""
	Takes a string ref and returns it in a form suitable for URLs, eg. "Mishna_Berakhot.3.5"
	"""
	pref = parse_ref(ref, pad=False)
	if "error" in pref: return False
	ref = make_ref(pref)
	if not ref: return False
	ref = ref.replace(" ", "_").replace(":", ".")

	# Change "Mishna_Brachot_2:3" to "Mishna_Brachot.2.3", but don't run on "Mishna_Brachot"
	if len(pref["sections"]) > 0:
		last = ref.rfind("_")
		if last == -1:
			return ref
		lref = list(ref)
		lref[last] = "."
		ref = "".join(lref)

	return ref


def top_section_ref(ref):
	"""
	Returns a ref (string) that corresponds to the highest level section above the ref passed.
	refs with no sections specified are padded to 1

	e.g., Job 4:5 -> Job 4, Rashi on Genesis 1:2:3 -> Rashi on Genesis 1
	"""
	pRef = parse_ref(ref, pad=True)
	if "error" in pRef:
		return pRef

	pRef["sections"] = pRef["sections"][:1]
	pRef["toSections"] = pRef["toSections"][:1]

	return make_ref(pRef)


def section_level_ref(ref):
	"""
	Returns a ref which corresponds to the text section which includes 'ref'
	(where 'section' is one level above the terminal 'segment' - e.g., "Chapter", "Daf" etc)

	If 'ref' is already at the section level or above, ref is returned unchanged.

	e.g., "Job 5:6" -> "Job 5", "Rashi on Genesis 1:2:3" -> "Rashi on Genesis 1:2"
	"""
	pRef = parse_ref(ref, pad=True)
	if "error" in pRef:
		return pRef

	pRef["sections"] = pRef["sections"][:pRef["textDepth"]-1]
	pRef["toSections"] = pRef["toSections"][:pRef["textDepth"]-1]

	return make_ref(pRef)

@logdecorator
def save_text(ref, text, user, **kwargs):
	"""
	Save a version of a text named by ref.

	text is a dict which must include attributes to be stored on the version doc,
	as well as the text itself,

	Returns indication of success of failure.
	"""
	# Validate Ref
	pRef = parse_ref(ref, pad=False)
	if "error" in pRef:
		return pRef

	# Validate Posted Text
	validated =  validate_text(text, ref)
	if "error" in validated:
		return validated

	text["text"] = sanitize_text(text["text"])

	chapter  = pRef["sections"][0] if len(pRef["sections"]) > 0 else None
	verse    = pRef["sections"][1] if len(pRef["sections"]) > 1 else None
	subVerse = pRef["sections"][2] if len(pRef["sections"]) > 2 else None

	# Check if we already have this	text
	existing = db.texts.find_one({"title": pRef["book"], "versionTitle": text["versionTitle"], "language": text["language"]})

	if existing:
		# Have this (book / version / language)

		# Only allow staff to edit locked texts
		if existing.get("status", "") == "locked" and not is_user_staff(user):
			return {"error": "This text has been locked against further edits."}

		# Pad existing version if it has fewer chapters
		if len(existing["chapter"]) < chapter:
			for i in range(len(existing["chapter"]), chapter):
				existing["chapter"].append([])

		# Save at depth 2 (e.g. verse: Genesis 4.5, Mishna Avot 2.4, array of comentary eg. Rashi on Genesis 1.3)
		if len(pRef["sections"]) == 2:
			if isinstance(existing["chapter"][chapter-1], basestring):
				existing["chapter"][chapter-1] = [existing["chapter"][chapter-1]]

			# Pad chapter if it doesn't have as many verses as the new text
			for i in range(len(existing["chapter"][chapter-1]), verse):
				existing["chapter"][chapter-1].append("")

			existing["chapter"][chapter-1][verse-1] = text["text"]


		# Save at depth 3 (e.g., a single Rashi Commentary: Rashi on Genesis 1.3.2)
		elif len(pRef["sections"]) == 3:

			# if chapter is a str, make it an array
			if isinstance(existing["chapter"][chapter-1], basestring):
				existing["chapter"][chapter-1] = [existing["chapter"][chapter-1]]
			# pad chapters with empty arrays if needed
			for i in range(len(existing["chapter"][chapter-1]), verse):
				existing["chapter"][chapter-1].append([])

			# if verse is a str, make it an array
			if isinstance(existing["chapter"][chapter-1][verse-1], basestring):
				existing["chapter"][chapter-1][verse-1] = [existing["chapter"][chapter-1][verse-1]]
			# pad verse with empty arrays if needed
			for i in range(len(existing["chapter"][chapter-1][verse-1]), subVerse):
				existing["chapter"][chapter-1][verse-1].append([])

			existing["chapter"][chapter-1][verse-1][subVerse-1] = text["text"]

		# Save at depth 1 (e.g, a whole chapter posted to Genesis.4)
		elif len(pRef["sections"]) == 1:
			existing["chapter"][chapter-1] = text["text"]

		# Save as an entire named text
		elif len(pRef["sections"]) == 0:
			existing["chapter"] = text["text"]

		# Update version source
		existing["versionSource"] = text["versionSource"]

		record_text_change(ref, text["versionTitle"], text["language"], text["text"], user, **kwargs)
		db.texts.save(existing)

		text_id = existing["_id"]
		del existing["_id"]
		if 'revisionDate' in existing:
			del existing['revisionDate']

		response = existing

	# New (book / version / language)
	else:
		text["title"] = pRef["book"]

		# add placeholders for preceding chapters
		if len(pRef["sections"]) > 0:
			text["chapter"] = []
			for i in range(chapter):
				text["chapter"].append([])

		# Save at depth 2 (e.g. verse: Genesis 4.5, Mishan Avot 2.4, array of comentary eg. Rashi on Genesis 1.3)
		if len(pRef["sections"]) == 2:
			chapterText = []
			for i in range(1, verse):
				chapterText.append("")
			chapterText.append(text["text"])
			text["chapter"][chapter-1] = chapterText

		# Save at depth 3 (e.g., a single Rashi Commentary: Rashi on Genesis 1.3.2)
		elif len(pRef["sections"]) == 3:
			for i in range(verse):
				text["chapter"][chapter-1].append([])
			subChapter = []
			for i in range(1, subVerse):
				subChapter.append([])
			subChapter.append(text["text"])
			text["chapter"][chapter-1][verse-1] = subChapter

		# Save at depth 1 (e.g, a whole chapter posted to Genesis.4)
		elif len(pRef["sections"]) == 1:
			text["chapter"][chapter-1] = text["text"]

		# Save an entire named text
		elif len(pRef["sections"]) == 0:
			text["chapter"] = text["text"]

		record_text_change(ref, text["versionTitle"], text["language"], text["text"], user, **kwargs)

		saved_text = text["text"]
		del text["text"]
		text_id = db.texts.insert(text)
		text["text"] = saved_text

		response = text

	# Finish up for both existing and new texts

	# count available segments of text
	if kwargs.get("count_after", True):
		summaries.update_summaries_on_change(pRef["book"])

	# Commentaries generate links to their base text automatically
	if pRef["type"] == "Commentary":
		add_commentary_links(ref, user, **kwargs)

	# scan text for links to auto add
	add_links_from_text(ref, text, text_id, user, **kwargs)

	# Add this text to a queue to be indexed for search
	from sefaria.search import add_ref_to_index_queue
	from sefaria.settings import SEARCH_INDEX_ON_SAVE
	if SEARCH_INDEX_ON_SAVE and kwargs.get("index_after", True):
		add_ref_to_index_queue(ref, response["versionTitle"], response["language"])

	return {"status": "ok"}


def merge_text(a, b):
	"""
	Merge two lists representing texts, giving preference to a, but keeping
	values froms b when a position in a is empty or non existant.

	e.g merge_text(["", "Two", "Three"], ["One", "Nope", "Nope", "Four]) ->
		["One", "Two" "Three", "Four"]
	"""
	length = max(len(a), len(b))
	out = [a[n] if n < len(a) and (a[n] or not n < len(b)) else b[n] for n in range(length)]
	return out


def validate_text(text, ref):
	"""
	validate a dictionary representing a text to be written to db.texts
	"""
	# Required Keys
	for key in ("versionTitle", "versionSource", "language", "text"):
		if not key in text:
			return {"error": "Field '%s' missing from posted JSON."  % key}

	pRef = parse_ref(ref, pad=False)

	# Validate depth of posted text matches expectation
	posted_depth = 0 if isinstance(text["text"], basestring) else list_depth(text["text"])
	implied_depth = len(pRef["sections"]) + posted_depth
	if  implied_depth != pRef["textDepth"]:
		return {"error": "Text Structure Mismatch. The stored depth of %s is %d, but the text posted to %s implies a depth of %d." % (pRef["book"], pRef["textDepth"], ref, implied_depth)}

	return {"status": "ok"}



def set_text_version_status(title, lang, version, status=None):
	"""
	Sets the status field of an existing text version.
	"""
	title   = title.replace("_", " ")
	version = version.replace("_", " ")
	text = db.texts.find_one({"title": title, "language": lang, "versionTitle": version})
	if not text:
		return {"error": "Text not found: %s, %s, %s" % (title, lang, version)}

	text["status"] = status
	db.texts.save(text)
	return {"status": "ok"}


def sanitize_text(text):
	"""
	Clean html entites of text, remove all tags but those allowed in ALLOWED_TAGS.
	text may be a string or an array of strings.
	"""
	if isinstance(text, list):
		for i, v in enumerate(text):
			text[i] = sanitize_text(v)
	elif isinstance(text, basestring):
		text = bleach.clean(text, tags=ALLOWED_TAGS)
	else:
		return False
	return text


def save_link(link, user, **kwargs):
	"""
	Save a new link to the DB. link should have:
		- refs - array of connected refs
		- type
		- anchorText - relative to the first?
	Key word args:
		auto: True if link is generated by an automatic process
		generated_by: text with the name of the automatic process

	"""
	if not validate_link(link):
		return {"error": "Error validating link."}

	auto = kwargs.get('auto', False)
	link["auto"] = 1 if auto else 0
	link["generated_by"] = kwargs.get("generated_by", None)
	link["source_text_oid"] = kwargs.get("source_text_oid", None)

	link["refs"] = [norm_ref(link["refs"][0]), norm_ref(link["refs"][1])]

	if not validate_link(link):
		return {"error": "Error normalizing link."}

	if "_id" in link:
		# editing an existing link
		objId = ObjectId(link["_id"])
		link["_id"] = objId
	else:
		# Don't bother saving a connection that already exists, or that has a more precise link already
		samelink = db.links.find_one({"refs": link["refs"]})

		if samelink and not auto and link["type"] and not samelink["type"]:
			samelink["type"] = link["type"]
			link = samelink
			objId = ObjectId(link["_id"])
			link["_id"] = objId

		elif samelink:
			logger.debug("save_link: Same link exists: " + samelink["refs"][1])
			return {"error": "This connection already exists. Try editing instead."}

		else:
			preciselink = db.links.find_one(
				{'$and':
					[
						{'refs': link["refs"][0]},
						{'refs':
							{'$regex': make_ref_re(link["refs"][1])}
						}
					]
				}
			)

			if preciselink:
				logger.debug("save_link: More specific link exists: " + link["refs"][1] + " and " + preciselink["refs"][1])
				return {"error": "A more precise link already exists: " + preciselink["refs"][1]}
			else:
			# this is a good new link
				objId = None

	db.links.save(link)
	record_obj_change("link", {"_id": objId}, link, user, **kwargs)

	logger.debug("save_link: Saved " + link["refs"][0] + " <-> " + link["refs"][1])

	return format_link_for_client(link, link["refs"][0], 0)


def save_link_batch(links, user, **kwargs):
	"""
	Saves a batch of link objects.

	Returns a list of return objects for each link
	"""
	res = []
	for link in links:
		res.append(save_link(link, user, **kwargs))
	return res


def validate_link(link):
	if False in link["refs"]:
		return False

	return True


def save_note(note, uid):
	"""
	Save a note repsented by the dictionary 'note'.
	"""
	note["ref"] = norm_ref(note["ref"])
	if "_id" in note:
		# updating an existing note
		note["_id"] = objId = ObjectId(note["_id"])
		existing = db.notes.find_one({"_id": objId})
		if not existing:
			return {"error": "Note not found."}
	else:
		# new note
		objId = None
		note["owner"] = uid
		existing = {}

	existing.update(note)
	db.notes.save(existing)

	if note["public"]:
		record_obj_change("note", {"_id": objId}, existing, uid)

	return format_note_for_client(existing)


def delete_link(id, user):
	record_obj_change("link", {"_id": ObjectId(id)}, None, user)
	db.links.remove({"_id": ObjectId(id)})
	return {"response": "ok"}


def delete_note(id, user):
	note = db.notes.find_one({"_id": ObjectId(id)})
	if not note:
		return {"error": "Note not found."}
	if note["public"]:
		record_obj_change("note", {"_id": ObjectId(id)}, None, user)
	db.notes.remove({"_id": ObjectId(id)})
	return {"response": "ok"}


def add_commentary_links(ref, user, **kwargs):
	"""
	Automatically add links for each comment in the commentary text denoted by 'ref'.
	E.g., for the ref 'Sforno on Kohelet 3:2', automatically set links for
	Kohelet 3:2 <-> Sforno on Kohelet 3:2:1, Kohelet 3:2 <-> Sforno on Kohelet 3:2:2, etc.
	for each segment of text (comment) that is in 'Sforno on Kohelet 3:2'.
	"""
	text = get_text(ref, commentary=0, context=0, pad=False)
	ref = norm_ref(ref)
	if not ref:
		return False
	book = ref[ref.find(" on ")+4:]

	if len(text["sections"]) == len(text["sectionNames"]):
		# this is a single comment, trim the last secton number (comment) from ref
		book = book[0:book.rfind(":")]
		link = {
			"refs": [book, ref],
			"type": "commentary",
			"anchorText": ""
		}
		save_link(link, user, auto=True, generated_by="add_commentary_links", **kwargs)

	elif len(text["sections"]) == (len(text["sectionNames"]) - 1):
		# This means that the text (and it's corresponding ref) being posted has the amount of sections like the parent text
		# (the text being commented on) so this is single group of comments on the lowest unit of the parent text.
		# and we simply iterate and create a link for each existing one to point to the same unit of parent text
		length = max(len(text["text"]), len(text["he"]))
		for i in range(length):
				link = {
					"refs": [book, ref + ":" + str(i+1)],
					"type": "commentary",
					"anchorText": ""
				}
				save_link(link, user, auto=True, generated_by="add_commentary_links", **kwargs)

	elif len(text["sections"]) > 0:
		# any other case where the posted ref sections do not match the length of the parent texts sections
		# this is a larger group of comments meaning it needs to be further broken down
		# in order to be able to match the commentary to the basic parent text units,
		# recur on each section
		length = max(len(text["text"]), len(text["he"]))
		for i in range(length):
			add_commentary_links("%s:%d" % (ref, i+1), user)
	else:
		#This is a special case of the above, where the sections length is 0 and that means this is
		# a whole text that has been posted. For  this we need a better way than get_text() to get the correct length of
		# highest order section counts.
		# We use the counts document for that.
		text_counts = counts.count_texts(ref)
		length = len(text_counts["counts"])
		for i in range(length):
			add_commentary_links("%s:%d" % (ref, i+1), user)


def add_links_from_text(ref, text, text_id, user, **kwargs):
	"""
	Scan a text for explicit references to other texts and automatically add new links between
	ref and the mentioned text.

	text["text"] may be a list of segments, an individual segment, or None.

	Lev - added return on 13 July 2014
	"""
	if not text or "text" not in text:
		return
	elif isinstance(text["text"], list):
		links = []
		for i in range(len(text["text"])):
			subtext = copy.deepcopy(text)
			subtext["text"] = text["text"][i]
			single = add_links_from_text("%s:%d" % (ref, i + 1), subtext, text_id, user, **kwargs)
			links += single
		return links
	elif isinstance(text["text"], basestring):
		links = []
		matches = get_refs_in_text(text["text"])
		for mref in matches:
			link = {"refs": [ref, mref], "type": ""}
			link = save_link(link, user, auto=True, generated_by="add_links_from_text", source_text_oid=text_id, **kwargs)
			if "error" not in link:
				links += [link]
		return links


def save_index(index, user, **kwargs):
	"""
	Save an index record to the DB.
	Index records contain metadata about texts, but not the text itself.
	"""
	global parsed, indices, texts_titles_cache, texts_titles_json
	index = norm_index(index)

	validation = validate_index(index)
	if "error" in validation:
		return validation

	# Ensure primary title is listed among title variants
	if index["title"] not in index["titleVariants"]:
		index["titleVariants"].append(index["title"])

	if "heTitle" in index:
		if "heTitleVariants" not in index:
			index["heTitleVariants"] = index["heTitle"]
		elif index["heTitle"] not in index["titleVariants"]:
			index["heTitleVariants"].append(index["heTitle"])

	title = index["title"]
	# Handle primary title change
	if "oldTitle" in index:
		old_title = index["oldTitle"]
		update_text_title(old_title, title)
		del index["oldTitle"]
	else:
		old_title = None

	# Merge with existing if any to preserve serverside data
	# that isn't visibile in the client (like chapter counts)
	existing = db.index.find_one({"title": title})
	if existing:
		index = dict(existing.items() + index.items())

	record_obj_change("index", {"title": title}, index, user)
	# save provisionally to allow norm_ref below to work
	db.index.save(index)
	# normalize all maps' "to" value
	if "maps" not in index:
		index["maps"] = []
	for i in range(len(index["maps"])):
		nref = norm_ref(index["maps"][i]["to"])
		if db.index.find_one({"titleVariants": nref}):
			return {"error": "'%s' cannot be a shorthand name: a text with this title already exisits." % nref }
		if not nref:
			return {"error": "Couldn't understand text reference: '%s'." % index["maps"][i]["to"]}
		index["maps"][i]["to"] = nref

	# now save with normilzed maps
	db.index.save(index)

	summaries.update_summaries_on_change(title, old_ref=old_title, recount=bool(old_title)) # only recount if the title changed

	# invalidate in-memory cache
	for variant in index["titleVariants"]:
		for title in indices.keys():
			if title.startswith(variant):
				print "Deleting index + " + title
				del indices[title]
	for ref in parsed.keys():
		if ref.startswith(index["title"]):
			print "Deleting parsed" + ref
			del parsed[ref]
	texts_titles_cache = texts_titles_json = None

	del index["_id"]
	return index


def update_index(index, user, **kwargs):
	"""
	Update an existing index record with the fields in index.
	index must include a title to find an existing record.
	"""
	if "title" not in index:
		return {"error": "'title' field is required to update an index."}

	# Merge with existing
	existing = db.index.find_one({"title": index["title"]})
	if existing:
		index = dict(existing.items() + index.items())
	else:
		return {"error": "No existing index record found to update for %s" % index["title"]}

	return save_index(index, user, **kwargs)


def validate_index(index):
	# Required Keys
	for key in ("title", "titleVariants", "categories", "sectionNames"):
		if not key in index:
			return {"error": "Text index is missing a required field: %s" % key}

	# Keys that should be non empty lists
	for key in ("categories", "sectionNames"):
		if not isinstance(index[key], list) or len(index[key]) == 0:
			return {"error": "%s field must be a non empty list of strings." % key}

	# Disallow special characters in text titles
	if any((c in '.-\\/') for c in index["title"]):
		return {"error": "Text title may not contain periods, hyphens or slashes."}

	# Disallow special character in categories
	for cat in index["categories"]:
		if any((c in '.-') for c in cat):
			return {"error": "Categories may not contain periods or hyphens."}

	# Disallow special character in sectionNames
	for cat in index["sectionNames"]:
		if any((c in '.-\\/') for c in cat):
			return {"error": "Text Structure names may not contain periods, hyphens or slashes."}

	# Make sure all title variants are unique
	for variant in index["titleVariants"]:
		existing = db.index.find_one({"titleVariants": variant})
		if existing and existing["title"] != index["title"]:
			if "oldTitle" not in index or existing["title"] != index["oldTitle"]:
				return {"error": 'A text called "%s" already exists.' % variant}

	return {"ok": 1}


def norm_index(index):
	"""
	Normalize an index dictionary.
	Uppercases the first letter of title and each title variant.
	"""
	index["title"] = index["title"][0].upper() + index["title"][1:]
	if "titleVariants" in index:
		variants = [v[0].upper() + v[1:] for v in index["titleVariants"]]
		index["titleVariants"] = variants

	return index


def update_text_title(old, new):
	"""
	Update all dependant documents when a text's primary title changes, inclduing:
		* titles on index documents (if not updated already)
		* titles of stored text versions
		* refs stored in links
		* refs stored in history
		* refs stores in notes
		* titles stored on text counts
		* titles in text summaries  - TODO
		* titles in top text counts
		* reset indices and parsed cache
	"""
	index = get_index(old)
	if "error" in index:
		return index

	# Special case if old is a Commentator name
	if index["categories"][0] == "Commentary" and "commentaryBook" not in index:
		commentary_text_titles = get_commentary_texts_list()
		old_titles = [title for title in commentary_text_titles if title.find(old) == 0]
		old_new = [(title, title.replace(old, new, 1)) for title in old_titles]
		for pair in old_new:
			update_text_title(pair[0], pair[1])

	update_title_in_index(old, new)
	update_title_in_texts(old, new)
	update_title_in_links(old, new)
	update_title_in_notes(old, new)
	update_title_in_history(old, new)
	update_title_in_counts(old, new)

	global indices, parsed
	indices = {}
	parsed = {}


def update_title_in_index(old, new):
	i = db.index.find_one({"title": old})
	if i:
		i["title"] = new
		i["titleVariants"].remove(old)
		i["titleVariants"].append(new)
		db.index.save(i)


def update_title_in_texts(old, new):
	versions = db.texts.find({"title": old})
	for v in versions:
		v["title"] = new
		db.texts.save(v)


def update_title_in_links(old, new):
	"""
	Update all stored links to reflect text title change.
	"""
	pattern = r'^%s(?= \d)' % re.escape(old)
	links = db.links.find({"refs": {"$regex": pattern}})
	for l in links:
		l["refs"] = [re.sub(pattern, new, r) for r in l["refs"]]
		db.links.save(l)


def update_title_in_history(old, new):
	"""
	Update all history entries which reference 'old' to 'new'.
	"""
	pattern = r'^%s(?= \d)' % re.escape(old)
	text_hist = db.history.find({"ref": {"$regex": pattern}})
	for h in text_hist:
		h["ref"] = re.sub(pattern, new, h["ref"])
		db.history.save(h)

	db.history.update({"title": old}, {"$set": {"title": new}}, upsert=False, multi=True)

	link_hist = db.history.find({"new": {"refs": {"$regex": pattern}}})
	for h in link_hist:
		h["new"]["refs"] = [re.sub(pattern, new, r) for r in h["new"]["refs"]]
		db.history.save(h)


def update_title_in_notes(old, new):
	"""
	Update all stored links to reflect text title change.
	"""
	pattern = r'^%s(?= \d)' % old
	notes = db.notes.find({"ref": {"$regex": pattern}})
	for n in notes:
		n["ref"] = re.sub(pattern, new, n["ref"])
		db.notes.save(n)


def update_title_in_counts(old, new):
	c = db.counts.find_one({"title": old})
	if c:
		c["title"] = new
		db.counts.save(c)


def update_version_title(old, new, text_title, language):
	"""
	Rename a text version title, including versions in history
	'old' and 'new' are the version title names.
	"""
	query = {
		"title": text_title,
		"versionTitle": old,
		"language": language
	}
	db.texts.update(query, {"$set": {"versionTitle": new}}, upsert=False, multi=True)

	update_version_title_in_history(old, new, text_title, language)


def update_version_title_in_history(old, new, text_title, language):
	"""
	Rename a text version title in history records
	'old' and 'new' are the version title names.
	"""
	query = {
		"ref": {"$regex": r'^%s(?= \d)' % text_title},
		"version": old,
		"language": language,
	}
	db.history.update(query, {"$set": {"version": new}}, upsert=False, multi=True)


def merge_text_versions(version1, version2, text_title, language):
	"""
	Merges the contents of two distinct text versions.
	version2 is merged into version1 then deleted.
	Preference is giving to version1 - if both versions contain content for a given segment,
	only the content of version1 will be retained.

	History entries are rewritten for version2.
	NOTE: the history of that results will be incorrect for any case where the content of
	version2 is overwritten - the history of those overwritten edits will remain.
	To end with a perfectly accurate history, history items for segments which have been overwritten
	would need to be identified and deleted.
	"""
	v1 = db.texts.find_one({"title": text_title, "versionTitle": version1, "language": language})
	if not v1:
		return {"error": "Version not found: %s" % version1 }
	v2 = db.texts.find_one({"title": text_title, "versionTitle": version2, "language": language})
	if not v2:
		return {"error": "Version not found: %s" % version2 }

	merged_text, sources = merge_translations([v1["chapter"], v2["chapter"]], [version1, version2])

	v1["chapter"] = merged_text
	db.texts.save(v1)

	update_version_title_in_history(version2, version1, text_title, language)

	db.texts.remove(v2)


def rename_category(old, new):
	"""
	Walk through all index records, replacing every category instance
	called 'old' with 'new'.
	"""
	indices = db.index.find({"categories": old})
	for i in indices:
		i["categories"] = [new if cat == old else cat for cat in i["categories"]]
		db.index.save(i)

	summaries.update_summaries()


def resize_text(title, new_structure, upsize_in_place=False):
	"""
	Change text structure for text named 'title'
	to 'new_structure' (a list of strings naming section names)

	Changes index record as well as restructuring any text that is currently saved.

	When increasing size, any existing text will become the first segment of the new level
	["One", "Two", "Three"] -> [["One"], ["Two"], ["Three"]]

	If upsize_in_place==True, existing text will stay in tact, but be wrapped in new depth:
	["One", "Two", "Three"] -> [["One", "Two", "Three"]]

	When decreasing size, information is lost as any existing segments are concatenated with " "
	[["One1", "One2"], ["Two1", "Two2"], ["Three1", "Three2"]] - >["One1 One2", "Two1 Two2", "Three1 Three2"]

	"""
	index = db.index.find_one({"title": title})
	if not index:
		return False

	old_structure = index["sectionNames"]
	index["sectionNames"] = new_structure
	db.index.save(index)

	delta = len(new_structure) - len(old_structure)
	if delta == 0:
		return True

	texts = db.texts.find({"title": title})
	for text in texts:
		if delta > 0 and upsize_in_place:
			resized = text["chapter"]
			for i in range(delta):
				resized = [resized]
		else:
			resized = resize_jagged_array(text["chapter"], delta)

		text["chapter"] = resized
		db.texts.save(text)

	# TODO Rewrite any existing Links
	# TODO Rewrite any exisitng History items

	summaries.update_summaries_on_change(title)
	reset_texts_cache()

	return True


def resize_jagged_array(text, factor):
	"""
	Return a resized jagged array for 'text' either up or down by int 'factor'.
	Size up if factor is positive, down if negative.
	Size up or down the number of times per factor's size.
	E.g., up twice for '2', down twice for '-2'.
	"""
	new_text = text
	if factor > 0:
		for i in range(factor):
			new_text = upsize_jagged_array(new_text)
	elif factor < 0:
		for i in range(abs(factor)):
			new_text = downsize_jagged_array(new_text)

	return new_text


def upsize_jagged_array(text):
	"""
	Returns a jagged array for text which restructures the content of text
	to include one additional level of structure.
	["One", "Two", "Three"] -> [["One"], ["Two"], ["Three"]]
	"""
	new_text = []
	for segment in text:
		if isinstance(segment, basestring):
			new_text.append([segment])
		elif isinstance(segment, list):
			new_text.append(upsize_jagged_array(segment))

	return new_text


def downsize_jagged_array(text):
	"""
	Returns a jagged array for text which restructures the content of text
	to include one less level of structure.
	Existing segments are concatenated with " "
	[["One1", "One2"], ["Two1", "Two2"], ["Three1", "Three2"]] - >["One1 One2", "Two1 Two2", "Three1 Three2"]
	"""
	new_text = []
	for segment in text:
		# Assumes segments are of uniform type, either all strings or all lists
		if isinstance(segment, basestring):
			return " ".join(text)
		elif isinstance(segment, list):
			new_text.append(downsize_jagged_array(segment))

	# Return which was filled in, defaulted to [] if both are empty
	return new_text


def delete_text(text):
	"""
	Fully deletes a text from Sefaria by:
	- Deleting the index document
	- Deleting all text documents
	- Deleting the counts document
	- Deleting all links pointing to this text

	If 'text' is the name of a commentator, delete_text will be called recursively
	for each commentary text that exists.
	"""
	i = get_index(text)

	if "error" in i:
		return i

	if i["categories"][0] == "Commentary" and "commentator" not in i:
		# This is the name of a Commentator alone (e.g., "Rashi")
		# delete all texts
		texts = db.texts.find({"title": {"$regex": "^%s on " % i["title"] }}).distinct("title")
		for t in texts:
			delete_text(t)
	else:
		db.links.remove({"refs": {"$regex": make_ref_re(text)}})
		db.texts.remove({"title": text})
		db.counts.remove({"title": text})

	db.index.remove({"title": text})


def reset_texts_cache():
	"""
	Resets caches that only update when text index information changes.
	"""
	global indices, parsed, texts_titles_cache, he_texts_titles_cache, texts_titles_json, toc_cache
	indices = {}
	parsed = {}
	toc_cache = None
	texts_titles_cache = None
	he_texts_titles_cache = None
	texts_titles_json = None
	delete_template_cache('texts_list')
	delete_template_cache('leaderboards')



def get_refs_in_text(text):
	"""
	Returns a list of valid refs found within text.
	"""
	lang = 'he' if is_hebrew(text) else 'en'

	titles = get_titles_in_text(text, lang)
	if not titles:
		return []

	if lang == "en":
		reg = "\\b(?P<ref>"
		reg += "(" + "|".join([re.escape(title) for title in titles]) + ")"
		reg += " \d+([ab])?([ .:]\d+)?([ .:]\d+)?(-\d+([ab])?([ .:]\d+)?)?" + ")\\b"
		reg = re.compile(reg)
	elif lang == "he":
		title_string = "|".join([re.escape(t) for t in titles])
		#Hebrew Unicode page: http://www.unicode.org/charts/PDF/U0590.pdf
		#todo: handle Ayin before Resh cases.
		#todo: This doesn't do ranges.  Do we see those in the wild?
		#todo: verify that open and closing parens are of the same type, so as not to fooled by (} or {)
		reg = ur"""(?<=										# look behind for opening brace
				[({{]										# literal '(', brace,
				[^}})]*										# anything but a closing ) or brace
			)
			(?P<ref>										# Capture the whole match as 'ref'
				({0})										# Any one book title, (Inserted with format(), below)
				\s+											# a space
				(\u05d3[\u05e3\u05e4\u05f3']\s+)?			# Daf, spelled with peh, peh sofit, geresh, or single quote
				(?:\u05e4(?:"|\u05f4|'')?)?				# Peh (for 'perek') maybe followed by a quote of some sort
				(?P<num1>									# the first number (1 of 3 styles, below)
					(?=\p{{Hebrew}}+(?:"|\u05f4|'')\p{{Hebrew}}) # (2: ") Lookahead:  At least one letter, followed by double-quote, two single quotes, or gershayim, followed by  one letter
						\u05ea*(?:"|\u05f4|'')?				# Many Tavs (400), maybe dbl quote
						[\u05e7-\u05ea]?(?:"|\u05f4|'')?	# One or zero kuf-tav (100-400), maybe dbl quote
						[\u05d8-\u05e6]?(?:"|\u05f4|'')?	# One or zero tet-tzaddi (9-90), maybe dbl quote
						[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)															#
					|(?=\p{{Hebrew}})						# (3: no punc) Lookahead: at least one Hebrew letter
						\u05ea*								# Many Tavs (400)
						[\u05e7-\u05ea]?					# One or zero kuf-tav (100-400)
						[\u05d8-\u05e6]?					# One or zero tet-tzaddi (9-90)
						[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)
					|\p{{Hebrew}}['\u05f3]					# (1: ') single letter, followed by a single quote or geresh
				)\s*										# end of the num1 group, maybe space
				[.:]?										# maybe a . for gemara refs or a : for tanach or gemara refs
				[,\s]*			    						# maybe a comma, maybe a space, maybe both
				(?:
					(?:\u05de\u05e9\u05e0\u05d4\s)			# Mishna spelled out, with a space after
					|(?:\u05de(?:"|\u05f4|'')?)				# or Mem (for 'mishna') maybe followed by a quote of some sort
				)?
				(?P<num2>									# second number - optional
					(?=\p{{Hebrew}}+(?:"|\u05f4|'')\p{{Hebrew}}) # (2: ") Lookahead:  At least one letter, followed by double-quote, two single quotes, or gershayim, followed by  one letter
						\u05ea*(?:"|\u05f4|'')?				# Many Tavs (400), maybe dbl quote
						[\u05e7-\u05ea]?(?:"|\u05f4|'')?	# One or zero kuf-tav (100-400), maybe dbl quote
						[\u05d8-\u05e6]?(?:"|\u05f4|'')?	# One or zero tet-tzaddi (9-90), maybe dbl quote
						[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)															#
					|(?=\p{{Hebrew}})						# (3: no punc) Lookahead: at least one Hebrew letter
						\u05ea*								# Many Tavs (400)
						[\u05e7-\u05ea]?					# One or zero kuf-tav (100-400)
						[\u05d8-\u05e6]?					# One or zero tet-tzaddi (9-90)
						[\u05d0-\u05d8]?					# One or zero alef-tet (1-9)
					|\p{{Hebrew}}['\u05f3]					# (1: ') single letter, followed by a single quote or geresh
				)?[.:]?										# end of the num2 group, maybe a . or : for gemara refs
			)												# end of ref capture
			(?=												# look ahead for closing brace
				[^({{]*										# match of anything but an opening '(' or brace
				[)}}]										# zero-width: literal ')' or brace
			)
		""".format(title_string)

		reg = regex.compile(reg, regex.VERBOSE)

	matches = reg.findall(text)
	refs = [match[0] for match in matches]
	if len(refs) > 0:
		for ref in refs:
			logger.debug("get_refs_in_text: " + ref)
	return refs


def get_titles_in_text(text, lang="en"):
	"""
	Returns a list of known text titles that occur within text.
	todo: Verify that this works for a Hebrew text
	"""

	all_titles = get_text_titles({}, lang)
	matched_titles = [title for title in all_titles if text.find(title) > -1]

	return matched_titles


def get_counts(ref):
	"""
	Look up a saved document of counts relating to the text ref.
	"""
	title = parse_ref(ref)
	if "error" in title:
		return title
	c = db.counts.find_one({"title": title["book"]})
	if not c:
		return {"error": "No counts found for %s" % ref}
	i = get_index(title["book"])
	if "error" in i:
		return i
	c.update(i)
	del c["_id"]
	return c



def get_text_titles(query={}, lang="en"):
	if lang == "en":
		return get_en_text_titles(query)
	elif lang == "he":
		return get_he_text_titles(query)
	else:
		logger.error("get_text_titles: Unsupported Language: %s", lang)


def get_en_text_titles(query={}):
	"""
	Return a list of all known text titles, including title variants and shorthands/maps.
	Optionally take a query to limit results.
	Cache the fill list which is used on every page (for nav autocomplete)
	"""
	global texts_titles_cache

	if query or not texts_titles_cache:
		titles = db.index.find(query).distinct("titleVariants")
		titles.extend(db.index.find(query).distinct("maps.from"))

		if query:
			return titles

		texts_titles_cache = titles

	return texts_titles_cache


def get_he_text_titles(query={}):
	global he_texts_titles_cache

	if query or not he_texts_titles_cache:
		titles = db.index.find(query).distinct("heTitleVariants")

		if query:
			return titles

		he_texts_titles_cache = titles

	return he_texts_titles_cache


def get_text_titles_json():
	"""
	Returns JSON of full texts list, keeps cached
	"""
	global texts_titles_json
	if not texts_titles_json:
		texts_titles_json = json.dumps(get_text_titles())

	return texts_titles_json


def get_text_categories():
	"""
	Reutrns a list of all known text categories.
	"""
	return db.index.find().distinct("categories")


def get_commentary_texts_list():
	"""
	Returns a list of text titles that exist in the DB which are commentaries.
	"""
	commentators = db.index.find({"categories.0": "Commentary"}).distinct("title")
	commentaryRE = "^(%s) on " % "|".join(commentators)
	texts = db.texts.find({"title": {"$regex": commentaryRE}}).distinct("title")

	return texts


def grab_section_from_text(sections, text, toSections=None):
	"""
	Returns a section of text from within the jagged array 'text'
	that is denoted by sections and toSections.
	"""
	if len(sections) == 0:
		return text
	if not text:
		return ""

	toSections = toSections or sections
	try:
		if sections[0] == toSections[0]:
			if len(sections) == 1:
				return text[sections[0]-1]
			else:
				return grab_section_from_text(sections[1:], text[sections[0]-1], toSections[1:])
		else:
			return text[ sections[0]-1 : toSections[0]-1 ]

	except IndexError:
		# Index out of bounds, we don't have this text
		return ""
	except TypeError:
		return ""

	return text
