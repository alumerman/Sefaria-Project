var sjs = sjs || {};

$.extend(sjs,  {
	Init: {},       // functions for initializing a page
	bind: {},       // functons for binding event handlers
	depth: 0,       // how deep the many steps in the current thread
	thread: [],     // a list of refs describing the path taken through texts
	view: {},       // cached values related to current view
	editing: {},    // data related to current editing
	ref: {},        // data relate to selecting a valid ref (e.g., in add source)
	reviews: {      // data of text reviews
		inProgress: {}
	},
	visible: {
		first: 1,
		last: 1
	},
	flags: {
		loading: false,        // are we currently loading a view? 
		verseSelecting: false, // are we currently selecting a verse?
		saving: false,         // are we currently saving text?
	},
	add: {
		source: null
	},
	timers: {
		hideMenu: null,
		panelPreivew: null,
	},
	palette: ["#5B1094", "#00681C", "#790619", "#CC0060", "#008391", "#001866", "#C88900", "#009486", "#935A10", "#9D2E2C"],
	sourcesFilter: "all",
	previousFilter: "all",
	_direction: 0,      // direction of text load animaition: -1 left, 0 no animation, 1 right
	_verseHeights: [],  // stored list of the top positon of each verse
	_scrollMap: []      // stored list of the window top position that should correspond to highlighting each verse
});

sjs.cache.params({notes: 1, sheets: 1}); // Default parameters to getting texts.

sjs.ratySettings = { // for text review ratings
	path: "/static/img/raty/",
	hints: ["Major problems", "Some problems", "Seems good", "Good", "Definately good"]
};


//  Initialize everything
sjs.Init.all = function() {
	
	// Init caches of jquery elements
	sjs.Init._$();

	// Bind functions to dom elements
	sjs.Init.handlers();

	sjs.view.width = $(window).width();

	if ("error" in sjs.current) {
		sjs.alert.message(sjs.current.error);
		sjs._$basetext.html("<center>Open another text with the texts menu above</center>")
		sjs._$aboutBar.hide();
		return;
	}

	var mode = sjs.current.mode || "view";
	switch (mode) {
		case "view":
			sjs.Init.loadView();
			break;
		case "add new":
			if (sjs.current.title) {
				$("#textTitle").val(sjs.current.title);
				$(".textName").text(sjs.current.title);
				$("#newIndexMsg").show();
				sjs.showNewIndex();
			} else {
				sjs.newText();
			}

			break;
		case "add":
			sjs.editing = sjs.current;
			sjs.editing.smallSectionName = sjs.editing.sectionNames[sjs.editing.sectionNames.length-1];
			sjs.editing.bigSectionName = sjs.editing.sectionNames[sjs.editing.sectionNames.length-2];
			sjs.editing.msg = "Add a New Text";
			sjs.showNewText();	
			break;
		case "edit":
			sjs.langMode = sjs.current.text.length ? 'en' : 'he';
			sjs.editText(sjs.current);
			break;
		case "translate":
			sjs.translateText(sjs.current);
			break;
		case "review":
			sjs.reviewText(sjs.current);
	}
};


sjs.Init._$ = function() {
	// ----------- Init Stored Elements ---------------
	sjs._$screen = $(".screen").eq(0);
	sjs._$basetext = $(".basetext").eq(0);
	sjs._$aboutBar = $(".aboutBar").eq(0);
	sjs._$commentaryViewPort = $(".commentaryViewPort").eq(0);
	sjs._$commentaryBox = $(".commentaryBox").eq(0);
	sjs._$sourcesBox = $(".sourcesBox").eq(0);
	sjs._$sourcesCount = $(".sourcesCount").eq(0);
	sjs._$sourcesList = $(".sourcesList").eq(0);
	sjs._$sourcesHeader = $(".sourcesHeader").eq(0);
	sjs._$sourcesWrapper = $(".sourcesWrapper").eq(0);
	sjs._$newVersion = $("#newVersion");
	sjs._$newVersionMirror = $("#newVersionMirror");
};


sjs.Init.loadView = function () {
	sjs.cache.save(sjs.current);
	History.replaceState(parseRef(sjs.current.ref), sjs.current.ref + " | Sefaria.org", null);

	var params = getUrlVars();
	if ("source" in params) {
		sjs.sourcesFilter = params["source"].replace(/_/g, " ");
	}
	buildView(sjs.current);
	if (sjs.langMode == "bi") { 
		$("#bilingual").trigger("click");
	}

	if ("nav_query" in params) {
		sjs.searchInsteadOfNav(params.nav_query);
	}
	
	sjs.thread = [sjs.current.ref];
	sjs.track.open(sjs.current.ref);
};


sjs.Init.handlers = function() {

	// ------------- Hide Modals on outside Click -----------
	
	$(window).click(function() {
		$(".boxOpen").removeClass("boxOpen");
		$(".zipOpen").removeClass("zipOpen");
		$(".zipBox").hide();
		$(".navBack").hide();
		$(".navBox").show();
		lowlightOff();
		$(".expanded").each(function(){ sjs.expandSource($(this)); });
		sjs.hideSources();
	});
	
	// --------- Don't let clicks on Modals trigger the above --------

	$(document).on('click touch', '.sModal, .open', function(e) { e.stopPropagation(); });

	// -------- Cache window width on window resize ------

	$(window).resize(function() {
		sjs.view.width = $(window).width();
	});

	
	// ------------- Top Button Handlers -------------

	var currentScrollPositionX = $(document).scrollTop();
	var currentScrollPositionY = $(document).scrollLeft();
	$(document).scroll(function(){
	    currentScrollPositionX = $(this).scrollTop();
	    currentScrollPositionY = $(this).scrollLeft();
	});

	var openBox = function(el, e) {
		clearTimeout(sjs.timers.hideMenu);
		$(".boxOpen").removeClass("boxOpen");
		$(el).addClass("boxOpen")
			.find(".anchoredMenu, .menuConnector").show();
		var $am = $(el).find(".anchoredMenu");
		if ($am.hasClass("center")) {
			$am.position({my: "top", at: "bottom", of: $(el).find(".menuConnector"), collision: "fit"});
		}
		$(el).find("input").focus();
		$(document).scrollTop(currentScrollPositionX);
		$(document).scrollLeft(currentScrollPositionY);
		e.stopPropagation();
		sjs.track.ui("Open #" + el.attr("id"));
	};

	var openBoxWrpr = function (e) {
		openBox($(this), e);
	}

	var closeBox = function(e) {
		var hide = function() {
			$('.boxOpen').find('input').blur();
			$(".boxOpen").removeClass("boxOpen")
				.find(".anchoredMenu, .menuConnector").hide();
		};
		if (isTouchDevice()) {
			hide();
		} else {
			sjs.timers.hideMenu = setTimeout(hide, 300);
		}
	};

	var toggleBox = function (e) {
		el = $(this);
		if (el.hasClass('boxOpen')) { 
			closeBox();
		} else {
			openBox(el, e);
		}
	}
	
	$(document).on('touch', '#open', toggleBox)
				.on('mouseenter', '#open', openBoxWrpr)	
				.on('mouseleave', '#open', closeBox)
				.on('click touch', 'body', closeBox)
				.on("click touch",'#open q', function(e) { e.stopPropagation(); });


	// Hide menus immediately when opening Sefaria menu
	$("#sefaria").click(function() {
		$(".boxOpen").removeClass("boxOpen").find(".anchoredMenu, .menuConnector").hide();
	});


	// ------------ Show / Hide Commentary Panel ----------------
	sjs.hideCommentary = function(e) {
		sjs._$basetext.addClass("noCommentary");
		sjs._$commentaryBox.addClass("noCommentary");
		$("body").addClass("noCommentary");
		sjs._$commentaryViewPort.fadeOut();
		sjs.track.ui("Hide Commentary")
		e.stopPropagation();
	};
	$(document).on("click", ".hideCommentary", sjs.hideCommentary);
	
	
	sjs.showCommentary = function(e) {
		sjs._$basetext.removeClass("noCommentary");
		sjs._$commentaryBox.removeClass("noCommentary");
		$("body").removeClass("noCommentary");
		sjs._$commentaryViewPort.fadeIn();
		$(this).addClass("hideCommentary")
			.removeClass("showCommentary");
		e.stopPropagation();
	};
	$(document).on("click", ".showCommentary", sjs.showCommentary);


	// --------- Open Side Panels (About & Sources) with Mouse Movements --------

	// Opening Side Panels with Mouse Movements
	sjs.mousePanels = function(e) {
		if (!sjs._$basetext.is(":visible") || $("#overlay").is(":visible") || e.clientY < 40) { return; }

		if (e.clientX < 20 && !$("#about").hasClass("opened")) {
			sjs.timers.previewPanel = setTimeout('$("#about").addClass("opened");', 100);
		} else if (sjs.view.width - e.clientX < 20 && !sjs._$sourcesList.hasClass("opened")) {
			sjs.timers.previewPanel = setTimeout('sjs._$sourcesList.addClass("opened");', 100);
		} 
	}
	$(window).mousemove(sjs.mousePanels);


	// ---------------- Sources Panel ---------------

	// Prevent any click on sourcesList from hiding itself (bound on window)
	$(document).on("click", ".sourcesList", function(e) { e.stopPropagation(); });

	sjs.showSources = function(e) {
		if (sjs.sourcesFilter === "Notes" || sjs.sourcesFilter === "Sheets") {
			// Swtiching form note mode back to previous source view
			sjs.sourcesFilter = sjs.previousFilter ? sjs.previousFilter : "all";
			buildCommentary(sjs.current.commentary);
			sjs.setFilters();
	
		} else if (sjs._$commentaryBox.hasClass("noCommentary") && sjs.current.commentary.length) {		  
			// Opening a hidden Commentary box
	  		sjs._$basetext.removeClass("noCommentary");
			sjs._$commentaryBox.removeClass("noCommentary");
			$("body").removeClass("noCommentary");
			sjs._$commentaryViewPort.fadeIn();
			$(".hideCommentary").show();
	
		} else {
			// Opening the Sources Panel
			sjs._$sourcesList.addClass("opened");
			clearTimeout(sjs.timers.previewPanel);
			sjs.track.ui("Show Source Filters");
		}
		if (e) { e.stopPropagation(); }
	};


	sjs.hideSources = function(e) {
		sjs.timers.hidePanel = setTimeout(function(){
			sjs._$sourcesList.removeClass("opened");
		}, 100);
	};
	$(document).on("mouseleave", ".sourcesList", sjs.hideSources);
	$(document).on("click touch", ".showSources", sjs.showSources);

	$(document).on("mouseleave", window, function() {
		clearTimeout(sjs.timers.hidePanel);
	});


	// Commentary filtering by clicking on source category
	$(document).on("click", ".source", function() {
		if (sjs.sourcesFilter === "Notes" || sjs.sourcesFilter === "Sheets") {
			// We're in Note mode, need to build commentary first
			buildCommentary(sjs.current.commentary);
		}
		$(".source").removeClass("active");
		$(this).addClass("active");

		if (!($(this).hasClass("sub"))) {
			$(".source .sub").hide();
			$(this).find(".sub").show();	
		}

		var category = $(this).attr("data-category");
		sjs.sourcesFilter = category
		sjs.filterSources(category);

		return false;
	});
		

	sjs.filterSources = function(cat) {
		// Filter sources for category 'cat'
		// 'kind' maybe either 'category' (text filter) or 'type' (connection filter)
		sjs.sourcesFilter = cat;

		if (cat === "all") {
			sjs._$commentaryViewPort.find(".commentary").removeClass("hidden");
		} else {
		// Hide everything, then show this
			sjs._$commentaryViewPort.find(".commentary").addClass("hidden");
			$(".commentary[data-category*='" + cat + "']").removeClass("hidden");
     	}

     	if (cat != "Notes" && cat != "Sheets") {
     		sjs.setSourcesCount();	
     	}
     	if (sjs._$verses) {
			// create a new scroll map, but only if the basetext
			// has been loaded already
			setScrollMap();
		}
	} 


	sjs.setFilters = function () {
		// Filter sources according to stored values sjs.sourcesFilter
		if (sjs.sourcesFilter !== "all") {
			sjs.filterSources(sjs.sourcesFilter);
		} else {
			sjs.filterSources("all");
		}

	}

	sjs.setSourcesCount = function() {
		// Set the count of visible / highlighted sources
		var text = "";
		var $c   = sjs._$commentaryBox;
		if (sjs.sourcesFilter === 'all') {
			// Don't check visible here, as there is a bit of lag in
			// actually showing the commentaries with the removeClass
			// above. We know that all commentaries are visible now.
			text += $c.find(".commentary").not(".lowlight").length + " Sources";

		} else if (sjs.sourcesFilter !== "Notes" && sjs.sourcesFilter !== "Sheets") {
			// Again, use not(.hidden) instead of :visible to avoid
			// the visibility race condition
			text += $c.find(".commentary").not(".hidden").not(".lowlight").length;
			text += " Sources (" + sjs.sourcesFilter.toProperCase() + ")";

		} else if (!sjs.previousFilter || sjs.previousFilter === 'all') {
			// We're not in Sources Mode 
			// There's no previous filter or previous filter is all
			text += sjs.current.commentary.length + " Sources";

		} else {
			// We're not in Sources Mode
			// there is a previous filter
			var cat  = sjs.previousFilter;
			//text = $c.find(".commentary[data-category*='" + cat + "']").not(".lowlight").length;
			text = String(sjs.current.commentary.length);
			text += " Sources (" + sjs.previousFilter.toProperCase() + ")";
		}
		
		sjs._$sourcesCount.text(text);
		$c = null;
	}

	sjs.setSourcesPanel = function(start, end) {
		// Set the HTML of the sources panel for the range start - end
		// or reset if no range preset.
		sjs._$sourcesWrapper.html(sourcesHtml(sjs.current.commentary, start, end));
	}


	// --------- Switching Sidebar views (Sheet / Notes / layers) ---------------
	sjs.switchSidebarMode = function(e) {
		// Switches the content of the sidebar, according to the present targets
		// data-sidebar attribute
		var mode   = $(this).attr("data-sidebar");
		var data   = sjs.current[mode];
		var filter = mode.toProperCase();

		if (sjs.sourcesFilter != "Notes" && sjs.sourcesFilter != "Sheets") {
			// Store this so we can switch back to previous filter
			sjs.previousFilter = sjs.sourcesFilter;
		}
		sjs.sourcesFilter = filter;
		buildCommentary(data);
		e.stopPropagation();
	}
	$(document).on("click touch", ".sidebarMode", sjs.switchSidebarMode);


	// --------------- About Panel ------------------
	sjs.showAbout = function() {
		$("#about").addClass("opened");
		sjs.loadAboutHistory();
		clearTimeout(sjs.timers.previewPanel);
		sjs.track.ui("Show About Panel")
	};
	sjs.hideAbout = function() {
		sjs.timers.hidePanel = setTimeout(function(){
			$("#about").removeClass("opened");
		}, 100);
	};
	sjs.toggleAbout = function() {
		if ($("#about").hasClass("opened")) {
			sjs.hideAbout();
		} else {
			sjs.showAbout();
		}
	}
	$(document).on("mouseenter", "#about", sjs.showAbout);
	$(document).on("mouseleave", "#about", sjs.hideAbout);
	$(document).on("click touch", '.aboutText', sjs.toggleAbout);

	sjs.loadAboutHistory = function() {
		// Load text attribution list only when #about is opened
		for (var lang in { "en": 1, "he": 1 }) {
			if (!lang) { continue; }
			if (!$(this).find("."+lang+" .credits").children().length) {
				var version = (lang === "en" ? sjs.current.versionTitle : sjs.current.heVersionTitle);
				if (!version) { continue; }
				var url = "/api/history/" + sjs.current.pageRef.replace(" ", "_") + "/" +
											lang + "/" +
											version.replace(" ", "_");
				
				var getLink = function(obj) { return obj["link"] };
				var setCredits = function(data, lang) {
					var html =  (data["translators"].length ? "<div class='credit'>Translated by " + data["translators"].map(getLink).join(", ") + "</div>" : "") +
								(data["copiers"].length ? "<div class='credit'>Copied by " + data["copiers"].map(getLink).join(", ") + "</div>" : "") +
								(data["editors"].length ? "<div class='credit'>Edited by " + data["editors"].map(getLink).join(", ") + "</div>" : "") +
								(data["reviewers"].length ? "<div class='credit'>Reviewed by " + data["reviewers"].map(getLink).join(", ") + "</div>" : "");

					$("#about").find("." + lang + " .credits").html(html);
				}
				var setCreditsWrp = (function(lang) { 
					return function(data) { setCredits(data, lang); };
				})(lang);

				$.get(url, setCreditsWrp);
			}
		}
	};


	// --------------- Ref Links -------------------
	
	$(document).on("click", ".refLink", sjs.bind.refLinkClick);


	// ------------- Next Link Url -----------------
		
	var event = isTouchDevice() ? 'touchstart' : 'click';
	$("#next, #prev").on(event, function() {
		if (this.id == "prev") 
			sjs._direction = -1;
		else
			sjs._direction = 1;
			
		var ref = $(this).attr("data-ref");
		if (ref) {
			get(parseRef(ref));
			sjs.track.ui("Nav Button #" + this.id);
		}

	});

	
	// ---------------- Layout Options ------------------
				
	$("#block").click(function(){
		$("#layoutToggle .toggleOption").removeClass("active");
		$(this).addClass("active");
		sjs._$basetext.addClass("lines");
		setVerseHeights();
		updateVisible();
	});
	
	$("#inline").click(function(){
		$("#layoutToggle .toggleOption").removeClass("active");
		$(this).addClass("active");
		sjs._$basetext.removeClass("lines");
		setVerseHeights();
		updateVisible();
	});
	
	// ------------------ Language Options ---------------
	
	sjs.changeLangMode = function() {
		var mode = this.id;
		var shortMode = this.id.substring(0,2);

		sjs.langMode = shortMode;
		$.cookie("langMode", shortMode);

		$("#languageToggle .toggleOption").removeClass("active");
		$(this).addClass("active");
		sjs._$basetext.removeClass("english bilingual hebrew heLeft")
			.addClass(mode);
		$("body").removeClass("english hebrew bilingual")
			.addClass(mode);
		
		if (mode === "bilingual") {
			sjs._$basetext.addClass("heLeft");
			$("body").addClass("heLeft");
			$("#layoutToggle").hide();
			$("#biLayoutToggle").show();
		} else {
			$("#layoutToggle").show();
			$("#biLayoutToggle").hide();			
		}

		sjs.updateReviewsModal(shortMode);

		setVerseHeights();
		updateVisible();
		return false;
	};
	$("#hebrew, #english, #bilingual").click(sjs.changeLangMode);
	
	
	// ------------ Bilingual Layout Options ----------------

	$("#heLeft").click(function() {
		$("#biLayoutToggle .toggleOption").removeClass("active")
		$(this).addClass("active")
		sjs._$basetext.addClass("heLeft");
		$("body").addClass("heLeft");

		return false;
	});

	$("#enLeft").click(function() {
		$("#biLayoutToggle .toggleOption").removeClass("active");
		$(this).addClass("active");
		sjs._$basetext.removeClass("heLeft");
		$("body").removeClass("heLeft");

		return false;
	});


}; // --------- End sjs.Init.handlers -------------


// -------------- DOM Ready ------------------------	
$(function() {
	sjs.Init.all();

	// TODO pull much of the code below into sjs.Init
	
	// ------------- History ---------------------

	$(window).bind("statechange", function(e) {
		var State = History.getState();
		actuallyGet(State.data);
	})


	// ------------iPad Fixes ---------------------
		
	if (isTouchDevice()) {
		$(window).bind('touchmove', updateVisible);
	}


	// -------------- Edit Text -------------------
		
	$("#editText").click(sjs.editCurrent);
	$(document).on("click", ".addThis", sjs.addThis);


	// ---------------- Edit Text Info ----------------------------

	$("#editTextInfo").click(sjs.editTextInfo);


// ------------- New Text --------------------------

	$("#addText").click(sjs.newText);


	$("#showOriginal").click(function(){
		$("body").toggleClass("newText");
		$("#newVersion").trigger("keyup");
		sjs._$newVersion.css("min-height", $("#newTextCompare").height()).trigger("autosize");

	});


	$("#newTextCancel").click(function() {
		$("#overlay").hide();
		$("#newTextMsg").text("Text or commentator name:");
		$("#newTextName").val("");
		$("#newTextModal").hide();
	});
	

	$("#newTextOK").click(function(){
		if (!sjs.editing.index) {
			// This is an unknown text
			var title = $("#newTextName").val()
			$("#textTitle").val(title);
			$(".textName").text(title);
			$("#newIndexMsg").show();
			sjs.showNewIndex();
		} else {
			// this is a known text
			$.extend(sjs.editing, parseRef($("#newTextName").val()));
			sjs.editing.sectionNames = sjs.editing.index.sectionNames;		
			sjs.editing.smallSectionName = sjs.editing.sectionNames[sjs.editing.sectionNames.length-1];
			sjs.editing.bigSectionName = sjs.editing.sectionNames[sjs.editing.sectionNames.length-2];
			sjs.editing.msg = "Add a New Text";
			sjs.editing.text = [""];
			sjs.showNewText();	
		}
		$("#newTextCancel").trigger("click");	
	});
	
// ------------------- New Index -------------------	
	
	$("#newIndexSave").click(function() {
		var index = sjs.readNewIndex();
		if (sjs.validateIndex(index)) 
			sjs.saveNewIndex(index);
	});
	
	$("#newIndexCancel").click(function() {
		var params = getUrlVars();
		if ("after" in params) {
			window.location = params["after"];
		} else {		
			sjs.clearNewIndex();
			$("#newIndex").hide();
			sjs._direction = 0;
			buildView(sjs.current);
		}
	})

	$("#textTitleVariants").tagit({
		allowSpaces: true
	});
	
// --------------- Add Version  ------------------
	
	$("#addVersion").click(function(e) {
		if (!sjs._uid) {
			return sjs.loginPrompt();
		}

		// Edit the SCT if it exists rather than offering a box to write a new one
		// to avoid unintentionally overwriting 
		if (sjs.current.versionTitle === "Sefaria Community Translation") {
			$("#english").trigger("click");
			sjs.editText(sjs.current);
			$("#showOriginal").trigger("click");
			sjs._$newVersion.css("min-height", $("#newTextCompare").height()).show().focus().autosize()

		} else {
			if (sjs._$basetext.hasClass("bilingual")) {
				$("#hebrew").trigger("click");
			}
			sjs.editing = sjs.current;
			sjs.showNewVersion()
		}
		e.stopPropagation();
	});
	
	$("#addVersionCancel").click(function() { 
		var params = getUrlVars();
		if ("after" in params) {
			window.location = params["after"];
		} else {
			sjs.clearNewVersion()
		}
	});
	
	$("#addVersionSave").click(function() {
		var version = readNewVersion();
		if (validateText(version)) {
			saveText(version);
		}
	})


// --------------------- Commentary Expansion ---------------

	sjs.handleCommentaryClick = function(e) {
		if ($(this).hasClass("lowlight")) {
			lowlightOff();
		}
		if (e.target.tagName !== "A" && // Allow links to be linky,
			!$(this).hasClass("noteMessage") &&  // Don't expand noteMessage
			!$(this).hasClass("sheet") ) // Don't expand sheet listings
		{ 
			// otherwise expand the source
			sjs.expandSource($(e.currentTarget));
		}	

		e.stopPropagation();
	};
	$(document).on("click", ".commentary", sjs.handleCommentaryClick);
	

// ----------------------- Commentary Edit --------------------

	sjs.editSource = function () {
		// Open the currently expanded source for editing.
		if (!sjs._uid) {
			return sjs.loginPrompt();
		}
		var $o = $(this).parents(".expanded");
		var source = {};
		
		source.id = parseInt($o.attr("data-id"));
		if ($o.hasClass("note")) {
			source.ref =  sjs.current.notes[source.id].anchorRef;
		} else {
			source.ref =  sjs.current.commentary[source.id].anchorRef;
		}
		sjs.add.source = source;
		
		buildOpen(true);
	};
	$(document).on("click", ".editLink", sjs.editSource);

	
// ----------------------- Translate Links --------------------
	
	sjs.translateThis = function () {
		// Open a view for translating of the ref stored in 
		// this's data-ref attribute. 
		if (!sjs._uid) {
			return sjs.loginPrompt();
		}
		
		var ref = $(this).attr("data-ref");
		var data = sjs.cache.get(ref);
		
		if (data) {
			sjs.translateText(data);
		} else {
			sjs.alert.saving("Looking up text...");
			$.getJSON("/api/texts/" + makeRef(parseRef(ref)), sjs.translateText);
		}
	};
	$(document).on("click", ".translateThis", sjs.translateThis);

	
// ------------------- Reviews ------------------------

	sjs.openReviews = function () {
		var lang = ($(this).hasClass("en") ? "en" : "he");
		sjs.updateReviewsModal(lang);
		$("#reviewsModal").show().position({of: window}).draggable();
		sjs.track.event("Reviews", "Open Reviews Modal", "");
	};
	$(document).on("click", ".reviewsButton", sjs.openReviews);

	sjs.closeReviews = function() {
		$("#reviewsModal").hide();
		$("#reviewsText").text("");
	};

	$(document).on("click", "#reviewsModal .cancel", sjs.closeReviews);	
	$(document).on("click", "#reviewsModal .save", sjs.saveReview);
	$(document).on("click", ".reviewDelete", sjs.deleteReview);

	$("#reviewText").change(sjs.storeReviewInProgress);

	$("#reviewHelpLink").click(function(e){ 
		e.preventDefault();
		$("#reviewsModal").addClass("reviewHelp").position({of: window});
	});
	$("#reviewHelpOK").click(function(){
		$("#reviewsModal").removeClass("reviewHelp");
	});

	$("#raty").raty(sjs.ratySettings);

// -------------- Highlight Commentary on Verse Click -------------- 

	sjs.hoverHighlight = function(e) {
		var n;
		$this = $(this);
		if ($this.hasClass("verse")) {
			n = $this.attr("data-num");
			$('[data-vref="'+n+'"]').addClass("highlight");
		} else if ($this.hasClass("commentary"))  {
			n = $this.attr("data-vref");
			$(this).addClass("highlight");
		}
		$('[data-num="'+n+'"]').addClass("highlight");
	};
	$(document).on("mouseenter", ".verse, .commentary", sjs.hoverHighlight );

	sjs.hoverHighlightOff = function(e) {
		$(".highlight").removeClass("highlight");
	};
	$(document).on("mouseleave", ".verse, .commentary", sjs.hoverHighlightOff );


	sjs.handleVerseClick = function(e) {
		if (sjs.editing.text){ return false; } //if we're editing a text, clicking on a verse span should do nothing
		
		// Figure out which segment or range of segments is selected
		if (sjs._$verses.filter(".lowlight").length) {
			// Is something already selected?
			$highlight = sjs._$verses.not(".lowlight");
			if ($highlight.is($(this)) && $highlight.length == 1) {
				// Did the click just happen on the only selected line? Then unselect it.
				$(window).trigger("click");
				return;
			}
			if ($highlight.length > 1 || $highlight.is($(this))) {
				// Is there already a range selected? reset if so
				var v = [$(this).attr("data-num"), $(this).attr("data-num")];		
			} else if ($highlight.length == 1) {
				var v = [$(this).attr("data-num"), $highlight.attr("data-num")].sort();
			}  
		} else {
			var v = [$(this).attr("data-num"), $(this).attr("data-num")];		
		}

		lowlightOn(v[0], v[1]);

		var selected = sjs.current.book + " ";
		for (var i = 0; i < sjs.current.sectionNames.length -1 ; i++) {
			selected += sjs.current.sections[i] + ":";
		}
		selected  += (v[0] === v[1] ? v[0] : v.join("-"));
		sjs.selected = selected;
		sjs.selected_verses = v;

		if (sjs.flags.verseSelecting) {			
			// Selecting a verse for add source
			sjs.add.source = {ref: selected};
			$("#selectedVerse").text(selected);
			$("#selectConfirm").show();
			$("#selectInstructions").hide();
		} else if (!isTouchDevice()) {
			// Add verseControls
			var offset = $(this).offset();
			var left = sjs._$basetext.offset().left + sjs._$basetext.outerWidth();
			var top = offset.top;
			var verseControls = '<div class="verseControls btn" ' +
				'style="left:'+ left +'px;top:'+top+'px">+' +
				'<div class="verseControlsList">' +
					'<span class="addSource">Add Source</span>' + 
					'<span class="addNote">Add Note</span>' + 
					'<span class="addToSheet">Add to Source Sheet</span>' +
					'<span class="copyToClipboard">Copy to Clipboard</span>' + 
					'<span class="editVerse">Edit Text</span>' +
					'<span class="translateVerse">Add Translation</span>' +
				'</div>' +
				'</div>';
			$("body").append(verseControls);
			$(".verseControls").click(function(e){ return false; });
			$(".verseControls span").click(function() { $(".verseControls").remove(); });
			$(".verseControls .addSource").click(addToSelected);
			$(".verseControls .addNote").click(addNoteToSelected);
			$(".verseControls .addToSheet").click(addSelectedToSheet);
			$(".verseControls .copyToClipboard").click(copySelected);
			$(".verseControls .editVerse").click(editSelected);
			$(".verseControls .translateVerse").click(translateSelected);
		}
	
		// Scroll commentary view port
		var $comments = $();
		for (var i = v[0]; i <= v[1]; i++ ) {
			$more = sjs._$commentaryBox.find(".commentary[data-vref=" + i + "]").not(".hidden");
			$comments = $comments.add($more);
		} 

		var $fc = $comments.eq(0);
		if ($fc.length == 1) {	
			var top = $(window).scrollTop() - $(this).offset().top + 120 ;					
			sjs._$commentaryViewPort.clearQueue().scrollTo($fc, {duration: 600, offset: top, easing: "easeOutExpo"})
		
		}
		sjs.setSourcesPanel(v[0], v[1]);
		sjs.setSourcesCount();
		return false;
	}
	$(document).on("click", ".verse", sjs.handleVerseClick );


	function addToSelected() {
		// Create a modal for adding a source to the segments selected in the UI
		// as represented by sjs.selected
		if (!sjs._uid) { return sjs.loginPrompt(); }

		$("#overlay").show();
		sjs.flags.verseSelecting = false;
		sjs.add.source = {ref: sjs.selected};
		buildOpen();

		return false;
	}


	function addNoteToSelected() {
		// Create a modal for adding a note to the segments selected in the UI
		// as represented by sjs.selected
		if (!sjs._uid) { return sjs.loginPrompt(); }

		addToSelected();
		$(".open").addClass("noteMode").position({of: $(window)});
		$("#addNoteTextarea").focus();

		return false;
	}


	function copySelected(e) {
		// Open a modal for copy-and-pasting containing the text of the currently
		// Selected segments, as represented by sjs.selected
		e.stopPropagation();
		var pRef = parseRef(sjs.selected);
		var start = parseInt(pRef.sections[pRef.sections.length-1])-1;
		var end = parseInt(pRef.toSections[pRef.toSections.length-1]);
		 
		var en = sjs.current.text.slice(start, end).join(" ");
		var he = sjs.current.he.slice(start, end).join(" ");

		var copyText = sjs.selected + ":\n\n" + he + "\n\n" + en;
		
		sjs.alert.copy(copyText);
	}
	

	function editSelected(e){
		// Open the selected segments for editing
		if (!sjs._uid) { return sjs.loginPrompt(); }

		sjs.editCurrent(e);

		var n = sjs.selected_verses[0];
		var top = $("#newTextNumbers .verse").eq(n-1).position().top - 100;
		$("html, body").animate({scrollTop: top, duation: 200});
	}
	

	function translateSelected(e){
		// Open a view to add a translations to the currently selected segments
		if (!sjs._uid) { return sjs.loginPrompt(); }

		sjs.translateText(sjs.current);

		var n = sjs.selected_verses[0];
		if (sjs._$newVersion.val() === "") {
			// Insert empty text (resulting in placeholders "...") up to selectd verse
			var text = "";
			for (var i = 0; i < n-1; i++) {
				text += "...\n\n";
			}
			sjs._$newVersion.val(text).trigger("keyup");
		}

		var top = $("#newTextCompare .verse").eq(n-1).position().top - 100;
		$("html, body").animate({scrollTop: top, duation: 200});
		
	}


// --------------- Add to Sheet ----------------

	function addSelectedToSheet(e) {
		if (!sjs._uid) { return sjs.loginPrompt(); }

		// Get sheet list if necessary
		if (!$("#sheets .sheet").length) {
			$("#sheets").html("Loading...");
			$.getJSON("/api/sheets/user/" + sjs._uid, function(data) {
				$("#sheets").empty();
				var sheets = "";
				for (i = 0; i < data.sheets.length; i++) {
					sheets += '<li class="sheet" data-id="'+data.sheets[i].id+'">'+
						$("<div/>").html(data.sheets[i].title).text() + "</li>";
				}
				sheets += '<li class="sheet new"><i>Start a New Source Sheet</i></li>'
				$("#sheets").html(sheets);
				$("#addToSheetModal").position({of:$(window)});
				$(".sheet").click(function(){
					$(".sheet").removeClass("selected");
					$(this).addClass("selected");
					return false;
				})
			})			
		}

		$("#addToSheetModal .sourceName").text(sjs.selected);

		$("#overlay").show();
		$("#addToSheetModal").show().position({
			my: "center center",
			at: "center center",
			of: $(window)
		});
		
		e.stopPropagation();
	}

	$("#addToSheetModal .cancel").click(function() {
		$("#overlay, #addToSheetModal").hide();
	})

	$("#addToSheetModal .ok").click(function(){
		// Protection against request getting sent multiple times (don't know why)
		if (sjs.flags.saving === true) { return false; }
		var selectedRef = sjs.selected;
		var selected = $(".sheet.selected");
		if (!selected.length) {
			sjs.alert.message("Please select a source sheet.");
			return false;
		}

		if (selected.hasClass("new")) {
			var title = prompt("New Source Sheet Name:", "");
			var sheet = {
				title: title,
				options: {numbered: 0},
				sources: [{ref: selectedRef}]
			};
			var postJSON = JSON.stringify(sheet);
			sjs.flags.saving = true;
			$.post("/api/sheets/", {"json": postJSON}, addToSheetCallback);	
		} else {
			var title = selected.html();
			var url = "/api/sheets/" + selected.attr("data-id") + "/add_ref";
			sjs.flags.saving = true;
			$.post(url, {ref: sjs.selected}, addToSheetCallback);	
		}

		function addToSheetCallback(data) {
			sjs.flags.saving = false;
			$("#addToSheetModal").hide();
			if ("error" in data) {
				sjs.alert.message(data.error);
			} else {
				sjs.alert.message(selectedRef + ' was added to "'+title+'".<br><br><a target="_blank" href="/sheets/'+data.id+'">View sheet.</a>');
			}
		}

	});


	// --------------- Add Source / Note through Select Modal ------------------------

	sjs.selectVerse = function(){
		if (!sjs._uid) {
			return sjs.loginPrompt();
		}
		sjs._$commentaryBox.hide();
		sjs._$sourcesList.removeClass("opened");
		$(".smallSectionName").text(sjs.current.sectionNames[sjs.current.sectionNames.length-1]);
		$("#verseSelectModal").show();
		$("#selectConfirm").hide();
		$("#selectInstructions").show();
		sjs.flags.verseSelecting = true;
		sjs.ref.tests = null;
		
		if ($(".lowlight").length) {
			$(".verse").not($(".lowlight")).trigger("click");
		}
		sjs.track.ui("Add Source Button Click");
		return false;
	};

	$(document).on("click", ".addSource", function() {
		sjs.selectType = "source";
		$(".sourceOrNote").text("Source");
		sjs.selectVerse();
		sjs.track.ui("Add Source Button Click");
	});

	$(document).on("click", ".addNote", function() {
		sjs.selectType = "note";
		$(".sourceOrNote").text("Note");
		sjs.selectVerse();
		sjs.track.ui("Add Note Button Click");

	});

	$(document).on("click", "#addSourceCancel", function(e) {
		$(".open").remove();
		$("#overlay") .hide();
		sjs.ref.tests = null;
	});
	
	$("#addModal").click(function() {
		return false;
	});
	
	// --------------- Verse Selecting ----------------
	
	$("#selectVerse").click(function() {
		$("#addModal, #overlay").hide();
		sjs._$commentaryBox.hide();
		sjs._$sourcesBox.hide();
		$("#verseSelectModal").show();
		sjs.flags.verseSelecting = true;
		
	});
	
	$("#verseSelectModal #selectOk").click(function() {
		if (sjs.selectType === "note") {
			addNoteToSelected();
		} else if (sjs.selectType == "source") {
			buildOpen();
		}

		sjs._$commentaryBox.show();
		sjs._$sourcesBox.show();
		$("#verseSelectModal").hide();
		sjs.flags.verseSelecting = false;

		return false;
		
	});
	
	$("#selectReset").click(function() {
		lowlightOff();
		$("#selectInstructions").show();
		$("#selectConfirm").hide();
	});
	
	$("#verseSelectModal .cancel").click(function() {
		$("#verseSelectModal").hide();
		if (sjs.current.commentary) sjs._$commentaryBox.show();
		sjs.flags.verseSelecting = false;
	});

// ------------- Nav Queries -----------------
	
	function navQueryOrSearch(query) {
		if (isRef(query)) {
			sjs._direction = 1;
			get(parseRef(query));
			sjs.track.ui("Nav Query");
			sjs.searchInsteadOfNav(query);
		} else {
			window.location = "/search?q=" + query;
		}
	}

	$("#goto").unbind("keypress").keypress(function(e) {
		var query = $("#goto").val();
		if (e.keyCode == 13 && query) {
			navQueryOrSearch(query)
			$(this).blur();
		}
	});
	$("#openText").unbind("mousedown").mousedown(function(){
		var query = $("#goto").val();
		if (query) {
			navQueryOrSearch(query)
			$(this).blur();
		}
	});

		
	// --------------- Locking Texts --------------------

	sjs.lockTextButtonHandler = function(e) {
		// handle a click to a lockTextButton by either locking or unlocking
		// the current text.
		if ($(this).hasClass("enVersion")) {
			var lang = "en";
			var version = sjs.current.versionTitle;
		} else if ($(this).hasClass("heVersion")) {
			var lang = "he";
			var version = sjs.current.heVersionTitle;
		} else {
			return;
		}

		var url = "/api/locktext/" + sjs.current.book + "/" + lang + "/" + version;
		var unlocking = $(this).hasClass("unlock");
		if (unlocking) {
			url += "?action=unlock";
		}

		$.post(url, {}, function(data) {
			if ("error" in data) {
				sjs.alert.message(data.error)
			} else {
				sjs.alert.message(unlocking ? "Text Unlocked" : "Text Locked");
				location.reload();
			}
		}).fail(function() {
			sjs.alert.message("Something went wrong. Sorry!");
		});

	};
	$(document).on("click", ".lockTextButton", sjs.lockTextButtonHandler);

				
}); // ---------------- End DOM Ready --------------------------



sjs.bind = {
	// Beginning to pull all event bindings into one place here
	windowScroll: function() {
		$(window).unbind("scroll.update").bind("scroll.update", updateVisible);
	}, 
	gotoAutocomplete: function() {
		$("input#goto").autocomplete({ source: function( request, response ) {
				var matches = $.map( sjs.books, function(tag) {
						if ( tag.toUpperCase().indexOf(request.term.toUpperCase()) === 0 ) {
							return tag;
						}
					});
				response(matches);
			}, 
			focus: function(){} });
	},
	refLinkClick: function (e) {
		if ($(this).hasClass("commentaryRef")) {
			$("#goto").val($(this).text() + " on ").focus();
			e.stopPropagation();
			return false;
		}

		var ref =  $(this).attr("data-ref") || $(this).text();
		if (!ref) return;
		ref = $(this).hasClass("mishnaRef") ? "Mishnah " + ref : ref;
		sjs._direction = $(this).parent().attr("id") == "breadcrumbs" ? -1 : 1;
		
		get(parseRef(ref));

		e.stopPropagation();
	}	
}


function get(q) {
	// Get the text represented by the query q
	// by way of pushing to the History API,
	// which in turn calls actuallyGet
	History.pushState(q, q.ref + " | Sefaria.org", "/" + makeRef(q));
	sjs.track.open(q.ref);
}


function actuallyGet(q) {
	// take an object representing a query
	// get data from api or cache
	// prepare a new screen for the text to live in
	// callback on buildView
	sjs.alert.loading();

	var direction = (sjs._direction === null ? -1 : sjs._direction);
	sjs.depth += direction;
	sjs._direction = null;

	var ref = humanRef(makeRef(q));
	var sliced = false;
	for (var i = 0; i < sjs.thread.length; i++) {
		if (sjs.thread[i] === ref) {
			sjs.thread = sjs.thread.slice(0, i+1);
			sliced = true;
		} 
	}
	
	if (!sliced) sjs.thread.push(ref);
	
	sjs.updateBreadcrumbs();

	sjs.flags.loading = true;

	$("#open, .boxOpen").removeClass("boxOpen");	
	$("#layoutToggle, #languageToggle, #overlay").hide();
	$("#goto").val("");
	sjs._$sourcesList.hide();
	$(".screen").addClass("goodbye");
	
	
	// Add a new screen for the new text to fill
	var screen = '<div class="screen">' +
						'<div class="basetext english"></div>' +
						'<div class="aboutBar gradient">' +
							'<div class="aboutBarBox">' +
								'<div class="btn aboutText">About Text</div>' +
							'</div>' +
						'</div>' +
						'<div class="commentaryBox">' +
							'<div class="hideCommentary"><div class="hideTab gradient">▸</div></div>' +
							'<div class="commentaryViewPort"></div>'+
							'<div class="sourcesBox gradient">'+
								'<div class="sourcesHeader">' +
									'<span class="btn showSources sourcesCount"></span>' +
									'<span class="btn showNotes sidebarMode" data-sidebar="notes">' +
										'<span class="notesCount"></span> Notes</span>' +
									'<div class="clear"></div>' +
								'</div>' +	
							'</div>' +
						'</div>' +
						'<div class="sourcesList sidePanel gradient"><div class="sourcesWrapper"></div></div>' +
				'</div>';
	
	$(".screen-container").append(screen);
	
	var $screen = $(".screen").last();
	
	// Copy old basetext classes (display, lang settings) to new basetext
	$screen.find(".basetext").attr("class", $(".goodbye").find(".basetext").attr("class")).removeClass("goodbye");
	$screen.attr("class", $(".goodbye").attr("class")).removeClass("goodbye");

	// Set screens far to the left to allow many backwards transitions
	$screen.css("left", 5000 + (sjs.depth * 100) + "%");
	
	// Give commentary box absolute positioning for duration of animation
	var top = $(window).scrollTop() + ($(window).height() * .09);
	var height = $(window).height() * .91;
	sjs._$commentaryBox.css({"position": "absolute", "top": top + "px", "height": height + "px", "bottom": "auto"})
		.addClass("animating");
	var aTop = $(window).scrollTop() + $(window).height() - 42;
	sjs._$aboutBar.css({"position": "absolute", "top": aTop, "bottom": "auto"})

	// Stored $elements now refer to the new screen
	sjs._$screen             = $screen;
	sjs._$basetext           = $(".basetext").last();
	sjs._$aboutBar           = $(".aboutBar").last();
	sjs._$commentaryBox      = $(".commentaryBox").last();
	sjs._$commentaryViewPort = $(".commentaryViewPort").last();
	sjs._$sourcesBox         = $(".sourcesBox").last();
	sjs._$sourcesWrapper     = $(".sourcesWrapper").last();
	sjs._$sourcesCount       = $(".sourcesCount").last();
	sjs._$sourcesList        = $(".sourcesList").last();
	sjs._$sourcesHeader      = $(".sourcesHeader").last();

	sjs._$commentaryBox.css({"position": "absolute", "top": top + "px", "bottom": "auto"})
			.addClass("animating"); 
	sjs._$aboutBar.css({"position": "absolute", "top": aTop})

	var ref = makeRef(q);
	if (sjs.cache.get(ref)) {
		buildView(sjs.cache.get(ref));
	} else {
		sjs.cache.get(ref, buildView);
	}
	$screen = null;
}


function buildView(data) {
	// take data returned from api and build it into the DOM
	if (data.error) {
		sjs.alert.message(data.error);
		return;
	}

	if (sjs._direction == 0) { $(".goodbye").hide() }

	var $basetext           = sjs._$basetext;
	var $commentaryBox      = sjs._$commentaryBox;
	var $commentaryViewPort = sjs._$commentaryViewPort;
	var $sourcesWrapper     = sjs._$sourcesWrapper;
	var $sourcesCount       = sjs._$sourcesCount;
	var $sourcesBox         = sjs._$sourcesBox;

	// Clear everything out 
	$basetext.empty().removeClass("noCommentary versionCompare").hide();
	$("body").removeClass("newText");
	$commentaryBox.removeClass("noCommentary").hide(); 
	$commentaryBox.find(".commentary").remove();
	$("#addVersionHeader, #newVersion, #newIndex, #editButtons").hide();
	$("#viewButtons, #sectionNav, #breadcrumbs").show();
	$("#about").removeClass("empty");
	$(".open").remove();	
	
	sjs.sourcesFilter = sjs.sourcesFilter || 'all';

	// Set the ref for the whole page, which may differ from data.ref if a single segmented is highlighted
	data.pageRef = (data.book + " " + data.sections.slice(0, data.sectionNames.length-1).join(":")).trim();

	sjs.cache.save(data);
	sjs.current = data;
	
	// Set Language based on what's available
	if (data.he.length && data.text.length) {
		$("#languageToggle").show();
	} else if (data.text.length && !data.he.length) {
		$("#languageToggle").hide();
		$("#english").trigger("click");
	} else if (data.he.length && !data.text.length) {
		$("#languageToggle").hide();
		$("#hebrew").trigger("click");
	}
	if (!sjs._$basetext.hasClass("bilingual")) $("#layoutToggle").show();
	
	// Texts that default to paragraph view - Tanach excluding Psalms and Talmud
	if (!(data.type in {Tanach:1, Talmud:1}) || data.book in {Psalms:1}) {
		$("#layoutToggle .toggleOption").removeClass("active");
		$("#block").addClass("active");
		sjs._$basetext.addClass("lines");
	}
	
	// Build basetext
	var emptyView = "<span class='btn addThis empty'>Add this Text</span>"+
		"<i>No text available.</i>";
	var basetext = basetextHtml(data.text, data.he, "", data.sectionNames[data.sectionNames.length - 1]);
	if (!basetext) {
		basetext = emptyView;
		$("#about").addClass("empty");
		$("#english").trigger("click");
		$("#viewButtons").hide();
	}
	
	// Make a Fancy Title String
	var sectionsString = "";
	if (data.title) {
		var basetextTitle = data.title;
	} else {
		var sectionNames = []
		for (var i = 0; i < data.sectionNames.length-1; i++) {
			sectionNames.push(data.sectionNames[i] + " " + data.sections[i]);
		}
		sectionsString = sectionNames.join(" : ");
		var basetextTitle = data.book.replace(/_/g, " ") + " " + sectionsString;
	}
	if (data.heTitle) {
		var start = data.sectionNames.length > 1 ? 0 : 1;
		var end = data.sectionNames.length - 1;
		var basetextHeTitle = data.heTitle + " " + data.sections.slice(start,end).map(encodeHebrewNumeral).join(", ");
	} else {
		var basetextHeTitle = basetextTitle;
	}
	
	// Add the fancy titles to the bastext	
	basetext = "<div class='sectionTitle'><span class='en'>" + basetextTitle + "</span>" +
		"<span class='he" + (basetextTitle === basetextHeTitle ? " enOnly" : "") + "'>" + 
		basetextHeTitle + "</span></div>" + 
		"<span class='spacer'></span>" +
		basetext +
		"<div class='clear'></div>"; 

	$("#next, #prev").css("visibility", "visible").show();

	// Build About Panel
	$("#aboutTextTitle").html(data.book);
	$("#aboutTextSections").html(sectionsString);
	$("#aboutVersions").html(aboutHtml());	


	// Don't allow editing a merged text
	if ("sources" in data) {
		$("#about").addClass("enMerged");
	} else {
		$("#about").removeClass("enMerged");
	}
	if ("heSources" in data) {
		$("#about").addClass("heMerged");
	} else {
		$("#about").removeClass("heMerged");
	}
	
	// Don't allow editing a locked text
	if (data.versionStatus === "locked" && !sjs.is_moderator) {
		$("#about").addClass("enLocked");
	} else {
		$("#about").removeClass("enLocked");
	}
	if (data.heVersionStatus === "locked" && !sjs.is_moderator) {
		$("#about").addClass("heLocked");
	} else {
		$("#about").removeClass("heLocked");
	}

	// Prefetch Next and Prev buttons
	if (data.next) {
		sjs.cache.prefetch(data.next);
		$("#next").attr("data-ref", data.next)
			.css("display", "inline-block")
			.removeClass("inactive");
	} else {
		$("#next").addClass("inactive");
	}
	if (data.prev) {
		sjs.cache.prefetch(data.prev);
		$("#prev").attr("data-ref", data.prev)
			.css("display", "inline-block")
			.removeClass("inactive");
	} else {
		$("#prev").addClass("inactive");
	}
	
	// Build Sidebar Content: Commentary, Notes, Sheets if any
	var sidebarContent = (sjs.sourcesFilter === "Notes" ? data.notes :
							sjs.sourcesFilter === "Sheets" ? data.sheets : 
																data.commentary);
	buildCommentary(sidebarContent);
	$("body").removeClass("noCommentary");
	$sourcesBox.find(".notesCount").text(data.notes.length);
	sjs.setFilters();
	sjs.setSourcesPanel();
	sjs.setSourcesCount();

	if (!data.commentary.length && !data.notes.length) {
		var emptyHtml = '<div class="sourcesActions">' +
							'<br /><div>No Sources or Notes have been added for this text yet.</div><br />' +
							'<span class="btn btn-success addSource">Add a Source</span>' +
							'<br /><br />' +
							'<span class="btn btn-success addNote">Add a Note</span>' + 
						'</div>';
		$sourcesCount.text("0 Sources").show();
		$basetext.addClass("noCommentary");
		$sourcesBox.addClass("noCommentary");
		$commentaryBox.addClass("noCommentary").show();
		$sourcesWrapper.html(emptyHtml);
		$(".hideCommentary").hide();
		$("body").addClass("noCommentary");
	}

	// Add Sheets Panels if we have sheets
	if (data.sheets && data.sheets.length) {
		$sourcesBox.find(".showNotes").before("<div class='btn showSheets sidebarMode' data-sidebar='sheets'>" + data.sheets.length + " Sheets</div>");
	}

	/// Add Basetext to DOM
	$basetext.html(basetext);
	sjs._$verses = $basetext.find(".verse");
	sjs._$commentary = $commentaryBox.find(".commentary");								

	$basetext.show();
	$sourcesBox.show();	
	sjs.bind.windowScroll();
	sjs.flags.loading = false;

	// Load textual reviews from API
	sjs.loadReviews();
	
	// highlight verse (if indicated)
	if (data.sections.length === data.textDepth) {
		var first = data.sections[data.sections.length-1];
		var last = data.toSections[data.toSections.length-1];
		lowlightOn(first, last);
	} 
	
	// Scroll horizontally to the new Screen
	var scrollXDur = sjs._direction == 0 ? 1 : 600;
	var scrollYDur = 200; // sjs._direction == 0 ? 1 : 200;

	// Animate horizonatally to new screen	
	$('.screen-container').css('position', 'fixed')
		.animate({left: '-' + (5000 + (sjs.depth * 100)) + "%"}, 
		{duration: scrollXDur, complete: function() {
			$('.goodbye').remove();
			$(this).css('position', 'relative');
			sjs._$commentaryBox.css({"position": "fixed", "bottom": "0", "top": "auto"})
				.removeClass("animating");
			sjs._$aboutBar.css({"position": "fixed", "top": "auto", "bottom": 0});
			sjs._verseHeights = [];
			setScrollMap();

			// Scroll vertically to the highlighted verse if any
			$highlight = sjs._$basetext.find(".verse").not(".lowlight").first();
		 	if ($highlight.length) {
		 		var top = $highlight.position().top - 100;
				$("html, body").animate({scrollTop: top}, scrollYDur)
		 	}
		 	
		 	/*
		 	// Show a contribute prompt on third page
			sjs.flags.evenHaEzerPrompt -= 1;
			if (sjs.flags.evenHaEzerPrompt === 0 && !$.cookie("hide_even_haezer_prompt")) {
				$("#contributePrompt, #overlay").show().position({my: "center center", 
														at: "center center",
														of: $(window)});
				$("#contributePrompt .btn.close").click(function(){
					if ($("#contributePrompt input").prop("checked")) {
						$.cookie("hide_even_haezer_prompt", true);
					}
					$("#contributePrompt, #overlay").hide();
				});

			}
			*/
		}
	});
	// clear loading message
	sjs.alert.clear();

	// Clear DOM references
	$basetext = $commentaryBox = $commentaryViewPort = $sourcesWrapper = $sourcesCount = $sourcesBox = null;

} // ------- END Build View---------------


function basetextHtml(en, he, prefix, sectionName) {
	var basetext = "";
	en = en || [];
	he = he || [];

	// Pad the shorter array to make stepping through them easier.
	var length = Math.max(en.length, he.length);
	en.pad(length, "");
	he.pad(length, "")

	// Step through both en and he together 
	for (var i = 0; i < Math.max(en.length, he.length); i++) {
        if (en[i] instanceof Array || he[i] instanceof Array) {
            basetext += basetextHtml(en[i], he[i], (i+1) + ".");
            continue;
        }
        var enButton = "<div class='btn addThis' data-lang='en' data-num='" + (i+1) +"'>" +
			"Add English for " + sectionName +  " " + (i+1) + "</div>";
		var enText = wrapRefLinks(en[i]) || enButton;
		var enClass = en[i] ? "en" : "en empty";

		var heButton = "<div class='btn addThis' data-lang='he' data-num='"+ (i+1) + "'>" +
			"Add Hebrew for " + sectionName + " " + (i+1) + "</div>";
		var heText = he[i] || heButton
		var heClass = he[i] ? "he" : "he empty";

		var n = prefix + (i+1);
		var verse =
			"<div class='verseNum'> " + n + " </div>" +
			'<span class="'+enClass+'">' + enText + "</span>" +
			'<span class="'+heClass+'">' + heText + '</span><div class="clear"></div>';

		basetext +=	'<span class="verse" data-num="'+ (prefix+n).split(".")[0] +'">' + verse + '</span>';

	}

	return basetext;
}


function buildCommentary(commentary) {
	// Take a list of commentary objects and build them into the DOM

	commentary = commentary || [];

	var $commentaryBox      = sjs._$commentaryBox;
	var $commentaryViewPort = sjs._$commentaryViewPort;
	var $sourcesWrapper     = sjs._$sourcesWrapper;
	var $sourcesCount       = sjs._$sourcesCount;
	var $sourcesBox         = sjs._$sourcesBox;

	var sources           = {};
	var commentaryObjects = []
	var commentaryHtml    = "";
	var n                 = 0; // number of assiged colors in pallette

	for (var i = 0; i < commentary.length; i++) {
		var c = commentary[i];

		if (c.error) { continue; }
		var type = c.type || "unknown type";

		// Give each Commentator a Color
		if (!(c.commentator in sources)) {
			var color = sjs.palette[n];
			var source = {color: color};
			sources[c.commentator] = source;
			n = (n+1) % sjs.palette.length;
		}
						
		sources[c.commentator].count++;
		
		// Make sure missing fields are treated as empty strings
		if (typeof(c.anchorText) == "undefined") c.anchorText = "";
		if (typeof(c.text) == "undefined") c.text = "";
		if (typeof(c.he) == "undefined") c.he = "";
		if (!c.heCommentator) c.heCommentator = c.commentator;

		// Set special classes based on type, language available, ownership
		var classStr = "";	
		if (type === "note") {
			classStr = "note " + 
				(isHebrew(c.text) ? "heNote" : "enNote") +
				(sjs._uid === c.owner ? " myNote" : "");

		} else if  (type === "sheet") {
			classStr = "sheet";

		} else {
			if (!c.text.length && c.he) classStr = "heOnly";
			if (!c.he.length && c.text) classStr = "enOnly";			
			if (c.category === "Commentary" && c.commentator.match(" on ")) {
				c.category = "Quoting Commentary"; 

			}
		}

		// Set English / Hebrew Text
		if (type === "sheet") {
			var enText = c.text;
			var heText = enText;
		} else if (type === "note") {
			var enText = c.title ? c.title + " - " + c.text : c.text;
			var heText = enText;
		} else {
			// Truncate the text put into te DOM, full txt available on click
			var enText = c.text;
			var heText = c.he
			enText = sjs.shortCommentaryText(enText, heText);
			heText = sjs.shortCommentaryText(heText, enText);			
		}

		var commentaryObject         = {};
		commentaryObject.vref        = c.anchorVerse;
		commentaryObject.ref         = c.ref;
		commentaryObject.cnum        = c.commentaryNum;
		commentaryObject.commentator = c.commentator;
		commentaryObject.heOnly      = classStr.indexOf("heOnly") == 0;
		commentaryObject.category    = c.category;
		commentaryObject.type        = type;
		commentaryObject.html = 
			'<span class="commentary ' + classStr + 
			    '" data-vref="' + c.anchorVerse + 
				'" data-id="' + i +
				'" data-category="' + c.category + ' ' + c.commentator +
				'" data-type="' + type +
				'" data-ref="' + (c.ref || "") + '">' + 
				'<span class="commentator' + (c.ref ? ' refLink' : '') + '"' + 
					' style="color:' + sources[c.commentator].color + 
					'" data-ref="'+ (c.ref || "") +'">' + 
						'<span class="en">'	+ c.commentator + 
						    (c.category == "Talmud" ? ' ' + parseRef(c.ref).sections[0] : '') + 
							(c.commentator ? ":" : "") +
						'</span>' +
						'<span class="he' + ("heTitle" in c ? '">' + c.heCommentator : ' enOnly">' + c.heCommentator) +
						    (c.category == "Talmud" ? ' <small>' + parseRef(c.ref).sections[0] + "</small>" : '') + 
							(c.heCommentator ? ":" : "") +
						'</span>' +
				'</span>' + 
				'<span class="anchorText">' + c.anchorText + '</span>' + 
				'<span class="text">' + 
					'<span class="en">' + enText + '</span>' + 
					'<span class="he">' + heText + '</span>' +
				'</span>' + 
			'</span>';

		commentaryObjects.push(commentaryObject);
	} 

	// Sort commentary 
	commentaryObjects.sort(sortCommentary);

	for (var i = 0; i < commentaryObjects.length; i++) {
		commentaryHtml += commentaryObjects[i].html;
	}

	if (commentaryHtml === "" && sjs.previousFilter !== "all") {
		commentaryHtml = "<div class='emptySidebarMessage'>There are no " + sjs.sourcesFilter + " here.</div>";
	}

	if (sjs.sourcesFilter === "Notes") {
		// Special messaging for Notes Panel
		commentaryHtml += "<div class='commentary note noteMessage' data-category='Notes'>" +
								"Your notes are private,<br>unless you choose to publish or share them.<br><br>" +
								"<div class='addNote btn btn-success'>Add a Note</div>" +
							"</div>";;
		$sourcesBox.find(".notesCount").text(commentary.length);
	}



	// To ensure user can scroll to the bottom on the content
	commentaryHtml += "<div class='commentaryBuffer'></div>";

	$commentaryViewPort.html(commentaryHtml)
						.slimscroll({
								height: "100%", 
								color: "#888",
								position: "left",
								distance: "0px",
							});
	$commentaryBox.show();

	// Clear DOM references
	$commentaryBox = $commentaryViewPort = $sourcesWrapper = $sourcesCount = $sourcesBox = null;      
}


function sortCommentary(a,b) {
	// Sort function for ordering commentary

	// First sort accoring to verse position
	// Use parseInt to look at only the first verse in cases where
	// vref is a string like "2 4 6" denoting multiple verses
	if (parseInt(a.vref) != parseInt(b.vref)) {
		return (parseInt(a.vref) > parseInt(b.vref)) ? 1 : -1;
	}

	// Sort commentaries according to their order
	if (a.cnum != 0 && b.cnum != 0) {
		return (a.cnum > b.cnum) ? 1 : -1; 
	}

	// Sort connections on the same source according to the order of the source text
	// e.g, Genesis Rabbah 1:2 before Genesis Rabbah 1:5
	if (a.commentator === b.commentator) {
		var aRef = parseRef(a.ref);
		var bRef = parseRef(b.ref);
		var length = Math.max(aRef.sections.length, bRef.sections.length)
		for (var i = 0; i < length; i++) {
			try {
				if (aRef.sections[i] != bRef.sections[i]) {
					return (aRef.sections[i] > bRef.sections[i]) ? 1 : -1;
				}
			} catch (e) {
				return (aRef.sections.length > bRef.sections.length) ? 1 : -1;
			}

		}
		return 0;
	}

	// Put bilingual texts first 
	if ((a.heOnly || b.heOnly) && !(a.heOnly && b.heOnly)) {
		return (a.heOnly ? 1 : -1);
	}

	// Put modern texts at the end
	if ((a.category === "Modern" || b.category === "Modern") && a.category != b.category) {
		return (a.category === "Modern" ? 1 : -1);
	}

	// Put notes at the end
	if ((a.type === "note" || b.type === "note") && a.type != b.type) {
		return (a.type === "note" ? 1 : -1);
	}

	// After these rules are applied, go random
	return Math.random() - 0.5;
}


function sourcesHtml(commentary, selected, selectedEnd) {
	// Return HTML for the sources panel built from counting objects in commentary
	// optionally looking only at the range select-selectedEnd of verses

	if (!selected) { var selected = selectedEnd = 0; }

	var sources = {};
	var types = {};
	var sourceTotal = 0;
	var n = m = 0;

	// Walk through and count all commentary objects given, disregard errors or commentaries
	// outside of selected verse (if any)
	for (var i = 0; i < commentary.length; i++) {
		var c = commentary[i];

		if (c.error || // Ignore errors
			(selected && (c.anchorVerse < selected || c.anchorVerse > selectedEnd)) // Ignore source out of range
		   ) {
			 continue;
		}

		// Add category if we haven't seen it already, give it a color
		if (!(c.category in sources)) {
			var color = sjs.palette[n];
			var source = {
					count: 0, 
					color: color, 
					subs: {}, 
					html: ""
				};
			n = (n+1) % sjs.palette.length;
			sources[c.category] = source;
		}
		sources[c.category].count++;
		// Count subcategories
		if (c.commentator in sources[c.category].subs) {
			sources[c.category].subs[c.commentator]++;
		} else {
			sources[c.category].subs[c.commentator] = 1;
		}
		sourceTotal++;

	}

	// -------------- Build Texts Filter -----------------
	var html = "<div class='textsFilter'><div class='source label active' data-category='all'>" +
				"<div class='cName'><span class='count'>("  + sourceTotal + ")</span> All Texts</div></div>";

	// If the current filter has no sources, include it anyway listed as count 0
	if (sjs.sourcesFilter !== "all" && !(sjs.sourcesFilter in sources)) {
		sources[sjs.sourcesFilter] = { count: 0, color: sjs.palette[n], subs:{}, html: "" }
	}

	// Set HTML for each Category
	for (category in sources) {
		sources[category].html += '<div class="source" data-category="' + category +
			'" style="color:'+ sources[category].color +
			'"><div class="cName"><span class="count">('+ sources[category].count+')</span> '+
			category + "</div>";
		
		// Sort subcategories (texts) by count
		var subsort = [];
		for (sub in sources[category].subs) {
			subsort.push([sub, sources[category].subs[sub]]);
			subsort.sort(function(a, b) {return b[1] - a[1]});
		}		
		for (var i = 0; i < subsort.length; i++) {
			sources[category].html += '<div class="source sub" data-category="' + subsort[i][0] +
			'"><div class="cName"><span class="count">('+ subsort[i][1]+')</span> ' + subsort[i][0]  + "</div></div>";
		}
		sources[category].html += '</div>';
	}

	// Sort sources by count
	var sortable = [];
	for (var source in sources) {
			
			sortable.push([source, sources[source].count, sources[source].html])
	}
	sortable.sort(function(a, b) {return b[1] - a[1]});

	// Add the HTML of each source to html
	for (var i = 0; i < sortable.length; i++) {
		html += sortable[i][2];
	}	
	html += '</div>';

	html += '<div class="sourcesActions">' + 
				'<span class="btn btn-success addSource">Add a Source</span>' +
				'<br><br>' +
				'<span class="btn btn-success addNote">Add a Note</span>' +

			'</div>';
	
	return html;
}



function aboutHtml(data) {
	// Retuns HTML for the About Text panel according to data.
	data = data || sjs.current;

	if (!(data.versionTitle || data.heVersionTitle || data.sources || data.heSources)) { 
		// Check if we've got at least something to work worth. Either a single Hebrew or English 
		// version or a merged Hebrew or English version.
		return "<i><center>No text available.</center></i>"; 
	}

	var enVersion = {
		title: data.versionTitle || "<i>Text Source Unknown</i>",
		source: data.versionSource || "",
		lang: "en",
		status: data.versionStatus,
		sources: ("sources" in data ? data.sources : null)
	};

	var heVersion = {
		title: data.heVersionTitle || "<i>Text Source Unknown</i>",
		source: data.heVersionSource || "",
		lang: "he",
		status: data.heVersionStatus,
		sources: ("heSources" in data ? data.heSources : null)
	};

	var aboutVersionHtml = function(version) {
		// Returns HTML describing a specific text version
		var html = '';
		if (version.sources && version.sources.unique().length > 1) {
		// This text is merged from multiples sources
			uniqueSources = version.sources.unique()
			html += '<div class="version '+version.lang+'"><span id="mergeMessage">This page includes merged sections from multiple text versions:</span>'
			for (i = 0; i < uniqueSources.length; i++ ) {
				html += '<div class="mergeSource">' +
					'<a href="/' + makeRef(data) + '/'+version.lang+'/' + uniqueSources[i].replace(/ /g, "_") + '">' + 
					uniqueSources[i] + '</a></div>';
			}
			html += "</div>";
		} else {
			var isSct = (version.title === "Sefaria Community Translation");

			var sourceLink = (version.source.indexOf(".") == -1 || version.source.indexOf(" ") != -1 ? 
				version.source:
				'<a target="_blank" href="' + version.source + '">' + parseURL(version.source).host + '</a>'); 
			html += '<div class="version '+version.lang+'">' +
						(isSct ? "Original Translation" : '<div class="aboutTitle">' + version.title + '</div>' +
						'<div class="aboutSource">Source: ' + sourceLink +'</div>') +
						'<div class="credits"></div>' +
						'<a class="historyLink" href="/activity/'+data.pageRef.replace(/ /g, "_")+'/'+version.lang+'/'+version.title.replace(/ /g, "_")+'">Full history &raquo;</a>' + 
						(sjs.is_moderator ? "<br>" +
							(version.status === "locked" ? 
								'<div class="btn btn-mini lockTextButton unlock ' + version.lang + 'Version">Unlock Text</div>' :
								'<div class="btn btn-mini lockTextButton ' + version.lang + 'Version">Lock Text</div>')
						: "") +
						(version.status === "locked" ? '<div class="lockedMessage"><div class="ui-icon ui-icon-locked"></div>This text has been locked to prevent further edits. If you believe this text requires further editing, please let us know by <a href="mailto:hello@sefaria.org">email</a>.</div>' : "" ) +
					'</div>';
		}
		return html;
	};

	var html = '<i>About this version:</i>' +  aboutVersionHtml(heVersion) + aboutVersionHtml(enVersion);

	// Build a list of alternate versions
	var versionsHtml = '';
	var versionsLang = {};
	var mergeSources = [];
	if ("sources" in data) { mergeSources = mergeSources.concat(data.sources); }
	if ("heSources" in data) { mergeSources = mergeSources.concat(data.heSources); }
	data.versions = data.versions || [];
	for (i = 0; i < data.versions.length; i++ ) {
		var v = data.versions[i];
		// Don't include versions used as primary en/he
		if (v.versionTitle === data.versionTitle || v.versionTitle === data.heVersionTitle) { continue; }
		if ($.inArray(v.versionTitle, mergeSources) > -1 ) { continue; }
		versionsHtml += '<div class="alternateVersion ' + v.language + '">' + 
							'<a href="/' + makeRef(data) + '/' + v.language + '/' + v.versionTitle.replace(/ /g, "_") + '">' +
							v.versionTitle + '</a></div>';
		versionsLang[v.language] = true;
	}

	if (versionsHtml) {
		var langClass = Object.keys(versionsLang).join(" ");
		html += '<div id="versionsList" class="'+langClass+'"><i>Other versions of this text:</i>' + versionsHtml + '</div>';
	}

	return html;

}


//  -------------------- Update Visible (Verse Count, Commentary) --------------------------

function updateVisible() {
	// Update view based on what text is currently visible in the viewport.
	// Currently, this means scrolling the commentary box to sync with content
	// visible in the baesetext.
	
	// Don't scroll if...
	if (sjs.flags.loading || // we're still loading a view
			!sjs._$verses || // verses aren't loaded yet
			sjs._$commentaryBox.hasClass("noCommentary") || // there's no commentary
			$(".commentary.expanded").length // commentary is expanded
		) {
		return;
	}

	var $v      = sjs._$verses;
	var $com    = sjs._$commentary.not(".hidden");
	var $w      = $(window);
	var nVerses = $v.length;
	var wTop    = $w.scrollTop() + 40;
	var wBottom = $w.scrollTop() + $w.height();
	
	// Look for first visible 
	for (var i = 0; i < sjs._verseHeights.length; i++) {
		if (sjs._verseHeights[i] > wTop) {
			sjs.visible.first = i + 1;
			break;
		}
	}
	
	// look for last visible
	for (var k=i+1; k < sjs._verseHeights.length; k++) {
		if (sjs._verseHeights[k] > wBottom) {
			sjs.visible.last = k - 1;
			break;
		}
	}
	
	// Scroll commentary...

	// If something is highlighted, scroll commentary to track highlight in basetext
	if ($(".lowlight").length) {
		var $first = $v.not(".lowlight").eq(0);
		var top = ($first.length ? $w.scrollTop() - $first.offset().top + 120 : 0);
		var vref = $first.attr("data-num");
		
		var $firstCom = $com.not(".lowlight").not(".hidden").eq(0);
		if ($firstCom.length) {
			sjs._$commentaryViewPort.clearQueue()
				.scrollTo($firstCom, {duration: 0, offset: top, easing: "easeOutExpo"})				
		}

	} else {				
	// There is nothing highlighted, scroll commentary to match basetext according to ScrollMap
		for (var i = 0; i < sjs._scrollMap.length; i++) {
			if (wTop < sjs._scrollMap[i] && $com.eq(i).length) {
				if (isTouchDevice()) {
					sjs._$commentaryViewPort.clearQueue()
						.scrollTop(sjs._$commentaryViewPort.scrollTop() + $com.eq(i).position().top);
				} else {
					var offset = $(window).scrollTop() - $com.eq(i).offset().top + 120 ;					
					sjs._$commentaryViewPort.clearQueue()
						.scrollTo($com.eq(i), {duration: 600, offset: 0, easing: "easeOutExpo"})
				}
				break;
			}
		}
	}


	// Clear DOM references
	$v = $com = $w = $first = $firstCom = null;

}


// ---------------- Breadcrumbs ------------------

sjs.updateBreadcrumbs = function() {
	if (sjs.thread.length === 1) {
		$("#breadcrumbs").hide();
		return;
	}
	
	var html = "";
	for (var i = sjs.thread.length-2; i > -1; i--) {
		html += "<span class='refLink'><span class='ui-icon ui-icon-triangle-1-w'></span>" + 
			sjs.thread[i].replace(/_/g, " ").replace(".", " ").replace(/\./g, ":") + 
			"</span>";
	}

	$("#breadcrumbs").html(html).show();
};

function addSourceSuccess() {
	// Function called when a user types a valid ref while adding a source
	// Requests the text of the ref and offers options to add source, edit texts or add texts
	// depending on the state of the text returned.
	// TODO this code should be replaced by a generic reusable widget

	var ref = $("#addSourceCitation").val();
	if (sjs.ref.index.categories[0] == "Commentary") {
		$("#addSourceType select").val("commentary");
	}
	
	ref = normRef(ref);
	
	$("#addSourceText").text("Checking for text…");
	
	$.getJSON("/api/texts/" + ref + "?commentary=0", function(data) {
		if (data.error) {
			$("#addSourceText").html(data.error);
			return;
		}
		
		sjs.ref.bookData = data;			
		var text = en = he = controlsHtml = "";
		
		if (data.sections.length < data.sectionNames.length) {
			data.sections.push(1);
			data.toSections.push(Math.max(data.text.length, data.he.length));
		}
						
		for (var i = data.sections[data.sections.length-1]-1; i < data.toSections[data.toSections.length-1]; i++) {
		
			if (data.text.length > i) {
				en += (i+1) + ". " + data.text[i] + "<br><br>";	
			}
			if (data.he.length > i) {
				he += (i+1) + ". " + data.he[i] + "<br><br>";	
			}
		}
			
		$("#addSourceEdit").removeClass("inactive");
		
		if (en && !he) {
			$("#addSourceHebrew").removeClass("inactive");
			$("#addSourceEnglish, #addSourceThis").addClass("inactive");
			$("#addSourceTextBox").removeClass("he");
			text = "<span class='en'>" + en + "</span>";

		} else if (!en && he) {
			$("#addSourceEnglish").removeClass("inactive");
			$("#addSourceHebrew, #addSourceThis").addClass("inactive");
			text = "<span class='he'>" + he + "</span>";
			$("#addSourceTextBox").addClass("he");

		} else if (he && en) {
			$("#addSourceHebrew, #addSourceEnglish, #addSourceThis").addClass("inactive");
			$("#addSourceTextBox .btn.he, #addSourceTextBox .btn.en").removeClass("inactive");
			$("#addSourceTextBox").removeClass("he");

			text = "<span class='en'>"+en+"</span>"+"<span class='he'>"+he+"</span>"
		} else if (!en && !he) {
			text = "<i>No text available.</i>"
			$("#addSourceTextBox .btn").addClass("inactive");
			$("#addSourceThis").removeClass("inactive");
		}
		

		$("#addSourceText").html(text);
		$(".open").position({of: $(window)});
		
		i++;
		if (data.type == "Commentary" && i > 1) {
			$("#addSourceSave").addClass("inactive");
			
			$("#addSourceComment").removeClass("inactive")
				.find(".commentCount").html(i + (i == 2 ? "nd" : i == 3 ? "rd" : "th"));
			
		} else { 
			$("#addSourceComment").addClass("inactive");
		}

		
		$("#addSourceSave").text("Save Source");
		
	});
	
}

sjs.expandSource = function($source) {
	// Animates the expanded version of a source on the source panel.
	// Also called to shrink a currently expanded source
	var id = parseInt($source.attr("data-id"));
	var c = $source.hasClass("note") ? sjs.current.notes[id] : sjs.current.commentary[id];
	
	if (c.type === "note") {
		var enText = c.title ? c.title + " - " + c.text : c.text;
		var heText = enText;
	} else {
		var enText = c.text;
		var heText = c.he
	}

	if ($source.hasClass("expanded")) {
		$source.find(".text .en").text(sjs.shortCommentaryText(enText, heText));
		$source.find(".text .he").text(sjs.shortCommentaryText(heText, enText));
		$source.removeClass("expanded");
		$(".commentary").removeClass("lowlight");
		return false;
	}

	// Add full, wrapped text to DOM
	$source.find(".text .en").html(wrapRefLinks(sjs.longCommentaryText(enText, heText)));
	$source.find(".text .he").html(sjs.longCommentaryText(heText, enText));

	// highlight and expand
	$(".commentary").addClass("lowlight").removeClass("expanded");
	$source.removeClass("lowlight").addClass("expanded");

	// prefetch sources
	$source.find(".refLink").each(function() {
		sjs.cache.prefetch($(this).attr("data-ref"))	
	});

	// scroll position after CSS Transitions are done
	setTimeout(function(){
		var height = $source.height();
		var boxHeight = sjs._$commentaryBox.height();
		var offset = -Math.max( ((boxHeight - height) / 2) - 40 , 0 );
		sjs._$commentaryViewPort.scrollTo($source, {duration: 400, 
													offset: offset,
													easing: "easeOutExpo",
													onAfter: function() { 
														var top = sjs._$commentaryViewPort.scrollTop();
														sjs._$commentaryViewPort.slimscroll({scroll: top});
														}
													});

	}, 160);


	var ref = $source.attr("data-ref");
	
	var editLink = $source.attr("data-type") == 'note' ? 
					(c.owner == sjs._uid ? "<span class='editLink'>Edit Note</span>" : "") :
					"<span class='editLink'>Edit Connection</span>";
	
	var translateLink = $source.hasClass("heOnly") ? 
						"<span class='translateThis' data-ref='" + ref + "'>Add Translation +</span>" :
						"";
	var openLink = $source.attr("data-type") == 'note' ?
					"" :
					"<span class='refLink' data-ref='" + normRef(ref) + "'>Open " + ref + " &raquo;</span>";

	if (!($source.find(".actions").length)) {
		var actionsHtml = "<div class='actions'>" +
							"<span class='connectionType'>[" + $source.attr("data-type").toProperCase() + "]</span>" +
							editLink +
							translateLink +
							openLink + 
						  "</div>";
		$source.append(actionsHtml);		
	}


};


sjs.shortCommentaryText = function (text, backup) {
	// Create a short version of commentary text for collaspsed display
	// Use backup if text is empty.
	var short = text || backup || "[no text available]";
	short = (isArray(short) ? short.join(" ") : short);
	if (short.length > 180) {
		short = short.substring(0,150)+"...";
	}
	short = short.stripHtml().escapeHtml();
	
	return short;
};


sjs.longCommentaryText = function(text, backup) {
	var long = text || backup || "[no text available]";
	long = (isArray(long) ? long.join(" ") : long);

	return long;
};


// ---------- Reviews ---------------

sjs.loadReviews = function () {
	// Calls the server to load both english and hebrew revies as needed
	sjs.reviews.en = null;
	sjs.reviews.he = null;
	if (sjs.current.text.length) { sjs.loadReview("en"); }
	if (sjs.current.he.length)   { sjs.loadReview("he"); }
};


sjs.loadReview = function(lang) {
	// Calls the server to load reviews for 'lang'
	// Updates reviewButtson when complete
	// If lang matches the lang of the current reviews modal, upate reviews modal content as well
	var version = (lang == "en" ? sjs.current.versionTitle : sjs.current.heVersionTitle);
	// If this is a merged text, do nothing. 
	if (!version) { return; }
	var url = sjs.current.pageRef + "/" + lang + "/" + version;

	$.getJSON("/api/reviews/" + url, function(data) {
		if ("error" in data) {
			sjs.alert.message(data.error);
			return;
		}
		sjs.reviews[data.lang] = data;

		sjs.updateReviewButton(data.lang);
		var currentLang = $("#reviewsModal").attr("data-lang") || sjs.langMode;
		if (data.lang == currentLang) {
			sjs.updateReviewsModal(currentLang);
		}

	});	
};


sjs.updateReviewButton = function(lang) {
	// Set the counts and colors for the reviews buttons for lang
	var data = sjs.reviews[lang];
	if (data) {
		$(".reviewsButton." + lang).remove();
		var classStr = sjs.scoreToClass(data.scoreSinceLastEdit) + " " + lang;
		// Call out unreviewed translations
		if (data.version === "Sefaria Community Translation" && data.scoreSinceLastEdit < 0.3) {
			classStr += " badge-error";
		} 
		var buttonHtml = 
			"<div class='reviewsButton "+ classStr + "'>" +
				(data.reviewCount ? data.reviewCount : "?") + 
			"</div>";
		//if (data.version === "Sefaria Community Translation") {
		//	$(".aboutBarBox").last().append(buttonHtml);
		//}
		$(".version." + lang + " .historyLink").before(buttonHtml);
	}
}


sjs.updateReviewsModal = function(lang) {
	// Creates content of reviews modal with stored reviews for lang

	// Don't do anything if called with "bi", let modal stay in its current language
	if (lang === "bi") { return; } 

	var data = sjs.reviews[lang];
	if (!data) {
		var version = (lang == "en" ? sjs.current.versionTitle : sjs.current.heVersionTitle);
		if (!version && $("#reviewsModal").is(":visible")) {
			sjs.alert.message("This text contains merged sections from multiple text versions. To review, please first select an individual version in the About Text Panel.");
		}
		return;
	} 

	// Store which language this modal is about, in case user switches to bilingual mode
	$("#reviewsModal").attr("data-lang", lang);

	// Set Title
	var longLang = {en: "English", he: "Hebrew"}[lang];
	var title = "Reviews of " + data.ref + ",  " + data.version + ", " + longLang;
	$("#reviewTitle").html(title);

	// Set About
	var about = "<span class='score raty' data-raty='" + (data.scoreSinceLastEdit || "0") + "'></span>" +
				"<span class='reviewCount'>(" + data.reviewCount + ")</span>";
	$("#reviewAbout").html(about);

	// Set list of past reviews
	var lastEditDateAdded = false; // if a last edited date has been added to its place chronologically
	var currentReview = null; // the already review made by user since last edit
	if (data.reviews.length) {
		var reviewsHtml = "";
		for (var i = 0; i < data.reviews.length; i++) {
			var review = data.reviews[i];
			if (review.user == sjs._uid && !lastEditDateAdded) {
				currentReview = review;
			}
			if (data.lastEdit > review.date && !lastEditDateAdded) {
				reviewsHtml += "<div class='lastEdit'>This text was last edited " + 
									(data.lastEdit !== null ?
										"on " + $.datepicker.formatDate('mm/dd/yy', new Date(data.lastEdit)) : 
										"before 01/05/2012") + " (review scores are reset from here)" +
								"</div>";
				lastEditDateAdded = true;
			}
			reviewsHtml += "<div class='review'>" + 
									(review.user == sjs._uid ? "<span class='reviewDelete' data-id='" + review._id + "'>delete</span>": "") +
									"<span class='reviewer'>" + review.userLink + "</span>" +
									"<span class='reviewDate'>" + $.datepicker.formatDate('mm/dd/yy', new Date(review.date)) + "</span><br>" +
									"<span class='reviewerScore raty' data-raty='" + review.score + "'></span>" +
									"<span class='reviewText'>" + review.comment.replace(/\n/g, "<br>") + "</span>" +
								"</div>";
		}		
	} else {
		var reviewsHtml = "<div class='noReviews'>This text has not yet been reviewed.</div>";
	}
	if (!lastEditDateAdded) {
		reviewsHtml += "<div class='lastEdit'>This text was last edited " + 
							(data.lastEdit !== null ?
								"on " + $.datepicker.formatDate('mm/dd/yy', new Date(data.lastEdit)) : 
								"before 01/05/2012") + 
						"</div>";
	}
	$("#reviews").html(reviewsHtml);

	// Init all rating stars
	$(".raty").each(function() {
		var score = parseFloat($(this).attr("data-raty")) * 5;
		var settings = $.extend({}, sjs.ratySettings, {score: score, readOnly: true, size: 14});
		$(this).raty(settings);
	});

	// Restore a review in progress, if it exists
	if (sjs.reviews.inProgress[sjs.getReviewKey()]) {
		currentReview = sjs.reviews.inProgress[sjs.getReviewKey()];
	}
	if (currentReview) {
		$("#reviewText").val(currentReview.comment);
		$("#raty").raty($.extend({}, sjs.ratySettings, {score: currentReview.score * 5}));
	} else {
		$("#reviewText").val("");
		$("#raty").raty(sjs.ratySettings);
	}

}


sjs.scoreToClass = function(score) {
	// Returns a CSS class for color coding reviews based on score. 

	//if (!score)      return "badge"; // Grey
	//if (score <= .3)  return "badge badge-error"; // Red 
	if (score <= .3)  return "badge";               // Grey 	
	if (score <= .7)  return "badge badge-warning"; // Yellow
	if (score >= .7)  return "badge badge-success"; // Green
};


sjs.saveReview = function() {
	// Validate form
	if (!$("#reviewText").val()) {
		sjs.alert.message("Please write a review message.");
		return;
	} else if (!$("#raty").raty("score")) {
		sjs.alert.message("Please give a review score.");
		return;
	}

	sjs.storeReviewInProgress();

	var url = sjs.getReviewKey();
	var review = sjs.readReview();
	var postJSON = JSON.stringify(review);
	sjs.alert.saving("Saving...");
	$.post("/api/reviews/" + url, {json: postJSON}, function(data){
		if ("error" in data) {
			sjs.alert.message(data.error)
		} else {
			sjs.alert.message("Review Saved.");
			sjs.loadReview(data.language);
			sjs.track.event("Reviews", "Save Review", "");
		}
	}).fail(function() {
		sjs.alert.message("There was an error saving your review. If the problem persists, try reloading the page.");
	});	
};

sjs.readReview = function() {
	var lang = $("#reviewsModal").attr("data-lang");
	var review = {
		comment: $("#reviewText").val(),
		score: $("#raty").raty("score") / 5,
		ref: sjs.current.pageRef,
		language: lang,
		version: lang == "en" ? sjs.current.versionTitle : sjs.current.heVersionTitle,
	};
	return review;
};


sjs.deleteReview = function(e) {
	if (confirm("Are you sure you want to delete this review?")) {
		var id = $(this).attr("data-id");
		$.ajax({
			type: "delete",
			url:  "/api/reviews/" + id,
			success: function(data) {
				if ("error" in data) {
					sjs.alert.message(data.error);
				} else {
					sjs.alert.message("Review deleted");
					sjs.loadReviews();
				}
			},
			error: function () {
				sjs.alert.message("There was an error deleting this reivew. Please reload the page and try again.");
			}
		});
	}
};


sjs.storeReviewInProgress = function() {
	// Store the text of a review in progress for a particular ref / lang / version
	// so it can be restored as the user change pages / languages modes.
	var key = sjs.getReviewKey();
	sjs.reviews.inProgress[key] = sjs.readReview();

};

sjs.getReviewKey = function() {
	// Returns the URL path for current ref / lang / verion
	var lang = sjs.langMode;
	if (lang == "bi") {
		lang = $("#reviewsModal").attr("data-lang");
	}
	if (lang == "en") {
		var key = sjs.current.pageRef + "/en/" + sjs.current.versionTitle;
	} else if (lang == "he") {
		var key = sjs.current.pageRef + "/he/" + sjs.current.heVersionTitle; 
	}

	return key.replace(/ /g, "_");
}

function buildOpen(editMode) {
	// Build modal for adding or editing a source or note
	// Previously, this same code create modals for viewing full text of a source.
	// if editMode, copy expanded source for editing
	// else, build a modal for adding a new source
	// This code is a mess and shoud be rewritten from scratch. 
	
	$(".open").remove();

	if (editMode) {
		// We're editing an existing source; grab data from expanded source
		var id          = parseInt($(".expanded").attr("data-id"));
		var commentator = $(".expanded").attr("data-ref");
		var enText      = $(".expanded .text .en").text();
		var heText      = $(".expanded .text .he").text();
		var anchorText  = $(".expanded .anchorText").text();
		var source      = $(".expanded").attr("data-source");
		var type        = $(".expanded").attr("data-type");
		var text        = (type === "note" ? sjs.current.notes[id].text : "");
		var title       = (type === "note" ? sjs.current.notes[id].title : "");
		var publicNote  = (type === "note" && sjs.current.notes[id].public);

		$("#selectedVerse").text($(".open .openVerseTitle").text());
	}
	
	var ref = sjs.add.source.ref;
	var sections = ref.split(":");
	var v = sections[sections.length - 1];
	
	var html = 	'<div class="open gradient edit'+ (editMode && type === "note" ? " noteMode": "") + '">' +
		'<div id="addSourceType" class="formRow">'+
			'<div class="label">Source Type:</div><select>'+
				'<option value="">Select type...</option>'+
				'<option value="commentary">Commentary</option>'+
				'<option value="quotation">Quotation</option>'+
				'<option value="reference">Reference</option>'+
				'<option value="summary">Summary</option>'+
				'<option value="explication">Explication</option>'+
				'<option value="related">Related Passage</option>'+
				'<option value="midrash">Midrash</option>'+
				'<option value="ein mishpat">Ein Mishpat / Ner Mitsvah</option>'+
				'<option value="mesorat hashas">Mesorat HaShas</option>'+
				'<option value="other">Other...</option>'+
			'</select><input id="otherType" placeholder=""></div>' +
		'<div class="formRow" id="anchorForm"><span class="label">Anchor Words:</span>' +
			'<input placeholder="optional"></div>' +
		'<div id="commentatorForm" class="formRow">'+
			'<div class="label">Citation:</div>' +
			'<input id="addSourceCitation" placeholder="e.g., Rashi, Brachot 32a:4-9, Bereshit Rabbah 3:4"></div>'+
		'<div class="formRow">' +
			'<div id="addSourceTextBox">' +
				'<div id="addSourceTextControls">' +
					"<span class='btn en inactive'>Show Hebrew</span>" +
					"<span class='btn he inactive'>Show English</span>" +
					"<span id='addSourceThis' class='btn inactive'>Add this Text</span>" +
					"<span id='addSourceEdit' class='btn inactive'>Edit Text</span>" +
					"<span id='addSourceEnglish' class='btn inactive'>Add Translation</span>" +
					"<span id='addSourceHebrew' class='btn inactive'>Add Hebrew</span>" +
					"<span id='addSourceComment' class='btn inactive'>Add <span class='commentCount'></span> Comment</span>" +
				'</div>' +
				'<div id="addSourceText">…</div></div></div>' +
		'<div id="addNoteTitleForm" class="formRow">'+
			'<div class="label" placeholder="optional">Note Title:</div>' +
			'<input id="addNoteTitle" value="'+(title || "")+'"></div>'+
		'<div class="formRow">' +
			'<textarea id="addNoteTextarea">'+(text || "")+'</textarea></div>' +
		'<div class="formRow" id="notePrivacyRow">' +
			'<input type="radio" name="notePrivacy" checked="checked"><b>Private</b> - only you can see this note&nbsp;&nbsp;&nbsp;' +
			'<input type="radio" name="notePrivacy" id="publicNote"><b>Public</b> - anyone can see this note</div>' +
		'<div id="addSourceControls">' + 
			'<span id="addSourceSave" class="btn btn-large inactive">Save Source</span>'+
			"<span id='addNoteSave' class='btn btn-large'>Save Note</span>" +
			'<span id="addSourceCancel" class="btn btn-large">Cancel</span></div>' +
		'</div>'
		

	$("body").append(html);
	var $o = $(".open");
	$("#addSourceCitation").val("");

	
	if (editMode) {
		// Populate fields for editing view
		$o.css("direction", "ltr").attr("data-id", id);
		
		$("#addSourceCitation").val(commentator);
		$("#anchorForm input").val(anchorText);
		if (anchorText) { 
			$("#anchorForm input").show();
		}
		$("#addSourceText").html("<span class='en'>"+enText+"</span><span class='he'>"+heText+"</span>");
		$("#sourceForm input").val(source);
		$("#addSourceType select").val(type);
		if (type !== "note") {
			$("#addSourceSave").removeClass("inactive"); 
			if (publicNote) { 
				$("#publicNote").attr("checked", "checked"); 
			}
		}

		// Show appropriate buttons related to this text
		$("#addSourceEdit").removeClass("inactive");
		if ($o.hasClass("noteMode")) {
			var comment = sjs.current.notes[parseInt(id)];
		} else {
			var comment = sjs.current.commentary[parseInt(id)];			
		}
		if (comment.text && comment.he) {
			$("#addSourceTextBox .btn.he, #addSourceTextBox .btn.en").removeClass("inactive");
			if (sjs.langMode === "he") {
				$("#addSourceTextBox").addClass("he");
			}
		} else if (comment.text) {
			$("#addSourceHebrew").removeClass("inactive");
		} else if (comment.he) {
			$("#addSourceTextBox").addClass("he");
			$("#addSourceEnglish").removeClass("inactive");
		}
	}

	var title = sjs.add.source ? 
				sjs.add.source.ref : 
				sjs.current.book + " " + sjs.current.sections.slice(0, sjs.current.sectionNames.length-1).join(":") + ":" + v;
	// Get at most 810 characters of the top text
	var enText = $(".verse").eq(v-1).find(".en").text().slice(0,810);
	var heText = $(".verse").eq(v-1).find(".he").text().slice(0,810);
	
	var openVerseHtml = "<div class='openVerse'>" +
							"<span class='en'>" + enText + "</span>" +
							"<span class='he'>" + heText + "</span>" +
						"</div>";

	$o.prepend(openVerseHtml);
	if ($o.hasClass("edit") && !editMode) {
		title = "Add a <span class='sourceTypeWord'><span>Source</span></span> to " + title;
		$("#addSourceCitation").focus();
	}
	var titleHtml = "<div class='openVerseTitle'>" + title + "</div>";
	if (editMode) titleHtml = "<div class='delete'>delete</div>" + titleHtml;
	$o.prepend(titleHtml);


	// Create a wrapper on checkRef() with appropriate parameters for this case
	checkSourceRef = function() {
		$("#addSourceText").html("");
		checkRef($("#addSourceCitation"), $("#addSourceText"), $("#addSourceSave"), 0, addSourceSuccess, true);
	}

	// Pull data from server as Citation is typed
	$("#addSourceCitation").autocomplete({ source: sjs.books, 
												select: checkSourceRef,
												focus: function() {},
												minLength: 2})
							.bind("textchange", function(e) {
								if (sjs.timers.checkSourceRef) clearTimeout(sjs.timers.checkSourceRef);
								sjs.timers.checkSourceRef = setTimeout("checkSourceRef();", 250);
							});

	// Bind functions for modal Buttons 
	$("#addSourceSave").click(handleSaveSource);
	$("#addNoteSave").click(handleSaveNote);
	$("#addSourceType select").change(function() {
		if ($(this).val() === "other") {
			$("#otherType").show();
		} else { 
			$("#otherType").hide();
		}
	});


	// Language toggles for addSourceText
	$("#addSourceTextBox .btn.en").click(function() {
		$("#addSourceTextBox").addClass("he")
	});
	$("#addSourceTextBox .btn.he").click(function() {
		$("#addSourceTextBox").removeClass("he")
	});

	// Add buttons 
	sjs.ref.bookData = null; // reset this - set by addSourceSuccess
	$("#addSourceHebrew, #addSourceEnglish, #addSourceThis, #addSourceComment").click(function() {
		if (!sjs._uid) {
			return sjs.loginPrompt();
		}

		var ref = $("#addSourceCitation").val();
		ref = makeRef(parseRef(ref));
		var that = this;
		if (!sjs.ref.bookData) {
			sjs.alert.saving("Looking up text...");
			$.getJSON("/api/texts/" + ref, function(data){
				sjs.alert.clear();
				sjs.ref.bookData = data;
				$(that).trigger("click");
			})
			return;
		}

		var data = sjs.ref.bookData;

		sjs.editing = data;
		sjs.editing.smallSectionName = data.sectionNames[data.sectionNames.length - 1];
		sjs.editing.bigSectionName = data.sectionNames[data.sectionNames.length - 2];
		sjs.editing.versionSource = '';
		if (data.type === "Commentary") {
			sjs.editing.offset = data.toSections[data.toSections.length-1] + 1;
		} else {
			sjs.editing.offset = data.sections[data.sections.length-1];
		}
		$.extend(sjs.editing, parseRef(ref));
		$("#overlay").hide();
		
		if (this.id in {"addSourceHebrew":1, "addSourceEnglish": 1}) {
			if (this.id == "addSourceHebrew") {
				sjs.langMode = "en"; // so english will show as compare text
				$("#language").val("he");
				$("#newVersion").css("direction", "rtl");
			} else {
				sjs.langMode = "he";
			}
			sjs.showNewVersion();

		} else {
			sjs.editing.msg = "Add a New Text";
			sjs.showNewText();
		}
		
	})

	// Edit the text of a Source
	$("#addSourceEdit").click(function() {
		if (!sjs._uid) {
			return sjs.loginPrompt();
		}
		sjs.alert.saving("Looking up text...");
		var text = $("#addSourceCitation").val().replace(/ /g, "_")
		if ($("#addSourceTextBox").hasClass("he")) {
			sjs.langMode = "he";
		} else {
			sjs.langMode = "en";
		}
		$.getJSON("/api/texts/" + text, sjs.editText)
			.error(function(){ sjs.alert.message("Sorry there was an error.")});
	});


	// Deleting a Source
	$(".open .delete").click(handleDeleteSource);

	$("#anchorForm input").focus(function() {
		$(".openVerse").show().position({my: "left top", at: "left+25 bottom", of: $("#anchorForm input")});
	}).blur(function() {
		$(".openVerse").hide();
	});

	$o.show().position({ my: "center center", at: "center center", of: $(window) }).draggable();
	$("#overlay").show();
	return false;

} // --------- End buildOpen Oy ------



sjs.makePlainText = function(text) {
	// Turn text array into a string, separating segments with \n\n
	// Replace empty strings in text with "..."

	// TODO - This currently removes any single line breaks inside text segments.
	// Line breaks inside segments currently screws things up but should be allowed later. 
	var placeholders = function(line) { return line ? line.replace(/\n/g, " ") : "..."; };
	var text = sjs.editing.text.map(placeholders).join('\n\n');
	return text
}


sjs.editText = function(data) {
		if (!sjs._uid) {
			return sjs.loginPrompt();
		}
		sjs.editing.book             = data.book;
		sjs.editing.sections         = data.sections;
		sjs.editing.sectionNames     = data.sectionNames;
		sjs.editing.smallSectionName = data.sectionNames[data.sectionNames.length-1];
		sjs.editing.bigSectionName   = data.sectionNames[data.sectionNames.length-2];
		
		if (sjs.langMode === 'en') {
			sjs.editing.versionTitle = data.versionTitle;
			sjs.editing.versionSource = data.versionSource;
			sjs.editing.heVersionTitle = data.heVersionTitle;
			sjs.editing.heVersionSource = data.heVersionSource;
			sjs.editing.text = data.text;
			sjs.editing.he = data.he;
			var pad = data.he ? Math.max(data.he.length - data.text.length, 0) : 0;
		} else if (sjs.langMode === 'he') {
			$("body").addClass("hebrew");
			sjs.editing.versionTitle = data.heVersionTitle;
			sjs.editing.versionSource = data.heVersionSource;
			sjs.editing.text = data.he;
			var pad = data.text ? Math.max(data.text.length - data.he.length, 0) : 0;
		} else if (sjs.langMode === 'bi') {
			sjs.alert.message("Select a language to edit first with the language toggle in the upper right.");
			return;
		} else {
			console.log("sjs.editText called with unknown value for sjs.langMode");
			return;
		}

		// If we know there are missing pieces of the text (compared to other lang)
		// pad with empty lines.
		for (var i = 0; i < pad; i++) {
			sjs.editing.text.push("");
		}
		
		sjs.editing.msg = "Edit Text";
		
		sjs.showNewText();

		// Set radio buttons for original/copy to appropriate state
		$('#versionTitle').val(sjs.editing.versionTitle);
		$('#versionSource').val(sjs.editing.versionSource);
		if ($("#versionTitle").val() in {"Sefaria Community Translation":1, "":1}) {
			$("#textTypeForm input#originalRadio").trigger("click");
		} else {
			$("#textTypeForm input#copyRadio").trigger("click");
		}

		var text = sjs.makePlainText(sjs.editing.text)
		$('#newVersion').val(text).trigger("autosize").trigger('keyup');

	};


sjs.editCurrent = function(e) {
	sjs.editText(sjs.current);
	e.stopPropagation();
};


sjs.addThis = function(e) {
	var lang = $(this).attr("data-lang");
	if (lang) {
		sjs.langMode = lang;
	}
	sjs.editCurrent(e);
	var n = parseInt($(this).attr("data-num"))
	if (n) {
		if (!sjs.editing.compareText || !sjs.editing.compareText.length) {
			var top = $("#newTextNumbers .verse").eq(n-1).position().top - 100;
		} else {
			$("#showOriginal").trigger("click");
			var top = $("#newTextCompare .verse").eq(n-1).position().top - 100;
		}
		sjs._$newVersion.trigger("autosize");
		$("html, body").animate({scrollTop: top, duation: 200});
	}
}

sjs.checkNewTextRef = function() {
	// Check ref function for new text UI
	checkRef($("#newTextName"), $("#newTextMsg"), $("#newTextOK"), 1, function(){}, false);
};
	

sjs.newText = function(e) {
	if (e) {
		e.preventDefault();
		e.stopPropagation();
	}
	if (!sjs._uid) {
		return sjs.loginPrompt();
	}

	$(".menuOpen").removeClass("menuOpen");
	$("#overlay").show();
	$("#newTextModal").show().position({of: $(window)});
	$("#newTextName").focus();
	$("#newTextOK").addClass("inactive");
	
	$("input#newTextName").autocomplete({ source: sjs.books, minLength: 2, select: sjs.checkNewTextRef});
	$("#newTextName").blur(sjs.checkNewTextRef);
	$("#newTextName").bind("textchange", function(e) {
		if (sjs.timers.checkNewText) {
			clearTimeout(sjs.timers.checkNewText);
		}
		sjs.timers.checkNewText = setTimeout(sjs.checkNewTextRef, 250);
	});
	sjs.ref.tests = null;
};


sjs.showNewVersion = function() {
	
	sjs.editing.compareText = sjs.langMode == "en" ? sjs.editing.text : sjs.editing.he;
	sjs.editing.compareLang = sjs.langMode;

	sjs.editing.smallSectionName = sjs.editing.sectionNames[sjs.editing.sectionNames.length-1];
	sjs.editing.bigSectionName = sjs.editing.sectionNames[sjs.editing.sectionNames.length-2];

	sjs.showNewText();
	
	sjs._$newVersion.css("min-height", $("#newTextCompare").height())
		.focus();

	var title = sjs.langMode == "en" ? sjs.editing.versionTitle : sjs.editing.heVersionTitle;
	var source = sjs.langMode == "en" ? sjs.editing.versionSource : sjs.editing.heVersionSource;
	$(".compareTitle").text(title);
	$(".compareSource").text(source);

	$("#versionSource").val("");
	$("body").removeClass("newText");
	$(".sidePanel").removeClass("opened");

	syncTextGroups($("#newTextCompare .verse"))

}


sjs.makeCompareText = function() {
	// Create DOM elements for comparison text while editing (usually, original text)
	// Assumes sjs.editing.compareText and sjs.editing.compareLang

	var compareText = sjs.editing.compareText;
	if (!compareText || !compareText.length) { 
		$("#showOriginal").hide();
		return; 
	}
	$("#showOriginal").show();
	var lang = sjs.editing.compareLang;
	var compareHtml = "";
	var start = sjs.editing.offset ? sjs.editing.offset - 1 : 0; 
	for (var i = start; i < compareText.length; i++) {
		compareHtml += '<span class="verse"><span class="verseNum">' + (i+1) + "</span>" +
			compareText[i] + "</span>";
	}
	$("#newTextCompare").html(compareHtml)
		.removeClass("he en")
		.addClass(lang);
}


sjs.clearNewVersion = function() {
	sjs.clearNewText();
	$("#newTextCompare").empty();
	sjs._direction = 0;
	buildView(sjs.current);
	sjs.editing = {};
}

	
sjs.showNewText = function () {
	// Show interface for adding a new text
	// assumes sjs.editing is set with: 
	// * msg -- displayed in header
	// * book, sections, toSections -- what is being edited
	// * smallSectionName, bigSectionName -- used in line numbering and title respectively
	// * text - the text being edited or "" if new text
	
	sjs.clearNewText();

	$("body").addClass("editMode");

	$(".sidePanel").removeClass("opened");
	$(".open, .verseControls").remove();
	$("#viewButtons, #prev, #next, #breadcrumbs").hide();
	$("#editButtons").show();
	$("body").addClass("newText");
	sjs._$commentaryBox.hide();
	sjs._$basetext.hide();
	$("#addVersionHeader").show();

	$(window).scrollLeft(0)
		.unbind("scroll.update")

	var title = sjs.editing.book.replace(/_/g, " ");
	for (var i = 0; i < sjs.editing.sectionNames.length-1; i++) {
		title += " : " + sjs.editing.sectionNames[i] + " " + sjs.editing.sections[i];
	}	

	if (!("compareText" in sjs.editing)) {
		sjs.editing.compareText = sjs.editing.he;
		sjs.editing.compareLang = "he";
		$(".compareTitle").text(sjs.editing.heVersionTitle);
		$(".compareSource").text(sjs.editing.heVersionSource);
	}

	sjs.makeCompareText();

	$("#editTitle").text(title);
	$("#versionSource").val(sjs.editing.versionSource);
	
	
	var verse_num = sjs.editing.offset || 1;
	$("#newTextNumbers").append("<div class='verse'>" + 
		sjs.editing.smallSectionName + " " + verse_num + "</div>");

	$("#newVersion").unbind().bind("textchange", checkTextDirection)
		.bind("keyup", handleTextChange)
		.autosize()
		.show();
	

	$("#textTypeForm input").click(function() {
		if ($(this).val() === "copy") {
			$("#copiedTextForm").show();

			// If an SCT was preloaded and the user clicks "Copied Text", reset the text fields 
			if (sjs.current.versionTitle === "Sefaria Community Translation" && sjs._$newVersion.val() === sjs.current.text.join("\n\n")) {
				sjs._$newVersion.val("").trigger("keyup");
				$("#copiedTextForm").find("input").val("");
			}
			$("#textTypeForm").removeClass("original");

		} else {
			$("#copiedTextForm").hide();
			if (sjs.current.versionTitle === "Sefaria Community Translation") {
				var text = sjs.makePlainText(sjs.editing.text)
				sjs._$newVersion.val(text)
					.trigger("keyup");
			}
			$("#textTypeForm").addClass("original");
		}
	});

	// Autocomplete version title with existing, autofill source for existing versions
	$.getJSON("/api/texts/versions/" + sjs.editing.book, function(data) {
		if ("error" in data) { return; }
		map = {};
		titles = [];
		for (var i = 0; i < data.length; i++) {
			titles.push(data[i].title);
			map[data[i].title] = data[i].source;
		}

		$("#versionTitle").autocomplete({source: titles, select: function(e, ui) {
			$("#versionSource").val(map[ui.item.value]);
		}}); 
	});

	$("#newVersionBox").show();

	// Set radio buttons for original/copy to appropriate state
	if ($("#versionTitle").val() in {"Sefaria Community Translation":1, "":1}) {
		$("#textTypeForm input#originalRadio").trigger("click");
	} else {
		$("#textTypeForm input#copyRadio").trigger("click");
	}
	

};

	
sjs.clearNewText = function() {
	sjs.alert.clear();
	sjs._$newVersion.val("").unbind().css("min-height", "none");
	$("#newTextNumbers").empty();
	$("#versionTitle, #versionSource").val("");
	$("#textTypeForm input").unbind();
	$("#newVersionBox").hide();
	$("body").removeClass("editMode");
};	


sjs.showNewIndex = function() {
	$("body").addClass("editMode");
	$(".sidePanel").removeClass("opened");
	$("#viewButtons, #prev, #next, #breadcrumbs, #overlay").hide();
	$(".verseControls, .open").remove();
	$(window).unbind("scroll.update resize.scrollLeft");
	sjs._$commentaryBox.hide();
	sjs._$basetext.hide();
	$(window).scrollLeft(0);

	$("#newIndexMsg").hide();
			
	$("#textCategory").unbind().change(function() {
		if ($(this).val() === "Other") $("#otherCategory").show();
		else $("#otherCategory").hide();

		if ($(this).val() === "Commentary") $("#textStructureFieldSet, #shorthandsFieldSet").hide();
		else $("#textStructureFieldSet, #shorthandsFieldSet").show();
	});

	$("#addSection").unbind().click(function() {
		$(this).before("<span class='sectionType'> > <input/> <span class='remove'>X</span></span>");
	});

	$("#sectionTypesBox").removeClass("fixedDepth");
	
	$("#addShorthand").unbind().click(function() {
		$(this).before('<div class="shorthand"><input class="shorthandFrom" /> ' + 
			'⇾ <input class="shorthandTo"/> <span class="remove">X</span>');
	});

	$(document).on("click", ".remove", function() {
		$(this).parent().remove();
	});
			
	$("#newIndex").show();
};
	

sjs.editTextInfo = function() {
	if (!sjs._uid) {
		return sjs.loginPrompt();
	}
    sjs.clearNewIndex();
	sjs.showNewIndex();

	var title    = sjs.current.commentator || sjs.current.book;
	var variants = sjs.current.commentator ? [] : sjs.current.titleVariants;
	var heTitle  = sjs.current.heBook || sjs.current.heTitle || null;

	sjs.editing.title = title; 

	// If this is a commentary, get commentator title variants from server
	if (sjs.current.commentator) {
		$.getJSON("/api/index/" + sjs.current.commentator, function(data){
			$("#textTitle").val(data.title);
			$("#heTitle").val(data.heTitle);
			data.titleVariants.forEach(function(variant) {
				$("#textTitleVariants").tagit("createTag", variant);
			});
		})
	} else {
		// Set Title
		$("#textTitle").val(title);
		// Set Title Variants
		variants.forEach(function(variant) {
			$("#textTitleVariants").tagit("createTag", variant);
		});		
	}



	// set Hebrew Titles
	if (heTitle) { 
		$("#heTitle").val( heTitle );
	}

	// Make list of categories currently in the select
	var cats = {};
	$("#textCategory option").each(function() {
    	cats[$(this).attr("value")] = 1;
	});

	// Set the Category if it's in the list, otherwise set it as "Other"
	if (sjs.current.type in cats) {
		$("#textCategory").val(sjs.current.type);
	} else {
		$("#textCategory").val("Other");
		$("#otherCategory").val(sjs.current.type).show();
	}
	// 
	$("#textCategory").trigger("change");

	// Remove a section name box if text depth is 1
	if (sjs.current.sectionNames.length == 1) {
		$(".sectionType:gt(0)").remove();
	}

	// Add additional section name boxes if needed
	for (var i = 2; i < sjs.current.sectionNames.length; i++) {
		$("#addSection").trigger("click");
	}
	
	// Populate sections names 
	$(".sectionType").each(function(){
		$(this).find("input").val(sjs.current.sectionNames[$(this).index()]);
	});
	
	// Add Shorthand boxes as needed
	for (var i = 1; i < sjs.current.maps.length; i++) {
		$("#addShorthand").trigger("click");
	}
	
	$(".shorthand").each(function(){
		if (!sjs.current.maps.length) return;
		$(this).find(".shorthandFrom").val(sjs.current.maps[$(this).index()].from);
		$(this).find(".shorthandTo").val(sjs.current.maps[$(this).index()].to);

	});

	
	// Check if texts are already saved with this schema,
	// If so, disallow schema changes
	$.getJSON("/api/counts/" + sjs.current.book, function(data){
		if ("error" in data) {
			return;
		} else {
			var count = 0;
			$.map(data.availableCounts, function(value, key) {
				for (var i=0; i < value.length; i++) {
					count += value[i]
				}
			});
		}
		if (count > 0) {
			$("#sectionTypesBox").addClass("fixedDepth");
		}
	});


};

sjs.clearNewIndex = function() {
	// Reset all forms and stored data related to editing text info (aka index).	
	$("#newIndexMsg").show();
	$("#newIndex input, #newIndex select").val("");
	$("#textTitleVariants").tagit("removeAll");
	$(".sectionType:gt(1)").remove();
	$(".shorthand:not(:first)").remove();
	$("#addShorthand").unbind();
	$("#addSection").unbind();
	sjs.editing.title = null;
	$("body").removeClass("editMode");
}	
	
	
sjs.readNewIndex = function() {
	// Return an object represent a text index (aka text info)
	// based on the states of the new index form in the DOM. 
	var index = {};
	
	index.title = $("#textTitle").val();
	if (sjs.editing.title && index.title !== sjs.editing.title) {
		// Primary title change
		index.oldTitle = sjs.editing.title;
		sjs.cache.killAll()
	}

	var heTitle = $("#heTitle").val();
	if (heTitle) { index["heTitle"] = heTitle; }
	index.titleVariants = $("#textTitleVariants").tagit("assignedTags")
	index.titleVariants.unshift(index.title);
	var cat = $("#textCategory").val();
	// Don't allow category updates to Tanach, Mishnah or Talmud
	// HACK to deal with incomplete handling on subcategories 
	if (cat in {"Tanach": 1, "Mishnah": 1, "Talmud": 1, "Tosefta": 1}) {
		index.categories = sjs.current.categories || "locked";
	} else {
		index.categories = (cat == "Other" ? [$("#otherCategory").val()] : [cat]);
	}
	var sectionNames = [];
	$(".sectionType input").each(function() {
		sectionNames.push($(this).val());
	})
	index.sectionNames = sectionNames;
	var maps = [];
	$(".shorthand").each(function() {
		var from = $(this).find(".shorthandFrom").val()
		var to = $(this).find(".shorthandTo").val()

		if (!from && !to) return;
		
		maps.push({"from": from, "to": to});
	});
	index.maps = maps;
	return index;
}
	

sjs.validateIndex = function(index) {

	if (!index.title) {
		sjs.alert.message("Please give a text title or commentator name.")
		return false;
	}

	if (/[.\-\\\/]/.test(index.title)) {
		sjs.alert.message('Text titles may not contain periods, hyphens or slashes.');
		return false;
	}

	if (/[0-9]/.test(index.title)) {
		sjs.alert.message('Text titles may not contain numbers. This form is for general information about a text as a whole, not specific citations.');
		return false;
	}

	if ("categories" in index && (index.categories.length === 0 || index.categories[0] === "")) {
		sjs.alert.message("Please choose a text category.")
		return false;
	}
	if ("categories" in index && index.categories === "locked") {
		sjs.alert.message("Adding new texts to Tanach, Mishnah and Talmud is currently locked. Please post to our Forum if you need to add a text to these categories.")
		return false;
	}

	for (var i = 0; i < index["categories"].length; i++) {
		if (/[.\-\\\/]/.test(index["categories"][i])) {
			sjs.alert.message('Categories may not contain periods, hyphens or slashes.');
			return false;
		}
	}


	if ( index.categories[0] !== "Commentary" ) {
		// Commentators don't need text structure specified

		if (index.sectionNames.length == 0 || index.sectionNames[0] === "") {
			sjs.alert.message("Please describe at least one level of text structure.")
			return false;
		}

		for (var i = 0; i < index["sectionNames"].length; i++) {
			if (/^\d+$/.test(index["sectionNames"][i])) {
				sjs.alert.message('Text Structure should be the names of the sections of this text generally (like "Chapter", "Verse", "Paragraph"), not numbers for a specific citation.');
				return false;
			}
			if (/[.\-\\\/]/.test(index["sectionNames"][i])) {
				sjs.alert.message('Text Structure names may not contain periods, hyphens or slashes.');
				return false;
			}
			if (index["sectionNames"][i].length == 0) {
				sjs.alert.message('Please give a name to each level of Text Structure, or remove unneeded levels.');
				return false;
			}

		}
	}

	if (containsHebrew(index.title)) {
		sjs.alert.message("Please enter a primary title in English. Use the Hebrew Title field to specify a title in Hebrew.")
		return false;
	}

	return true;
};


sjs.saveNewIndex = function(index) {

	var postJSON = JSON.stringify(index);
	var title = index["title"].replace(/ /g, "_");

	sjs.alert.saving("Saving text information...")
	$.post("/api/index/" + title,  {"json": postJSON}, function(data) {
		if (data.error) {
			sjs.alert.message(data.error);
		} else if ("oldTitle" in index) {
			// Full reload needed if primary name has changed
			$("#newIndex").hide();
			sjs.clearNewIndex();
			sjs.alert.message("Text information saved.");
			var ref = data.title + " " +
				(data.categories[0] == "Commentary" ? "on " + sjs.current.commentaryBook + " " : "") +
				sjs.current.sections.join(" ");
			get(parseRef(ref));
		} else {
			$("#newIndex").hide();
			sjs.books.push.apply(sjs.books, data.titleVariants);
			for (var i = 0; i < data.maps.length; i++)
				sjs.books.push(data.maps[i].from);
			sjs.bind.gotoAutocomplete();
			sjs.alert.clear();
			if (!sjs.editing.title) {
				// Prompt for text to edit if this edit didn't begin
				// as a edit of an existing text.
				$("#addText").trigger("click");
				$("#newTextName").val(data.title).trigger("textchange");
			} else {
				$.extend(sjs.current, index);
				if ("text" in sjs.current) {
					buildView(sjs.current);
				}
				sjs.alert.message("Text information saved.");
			}
			sjs.clearNewIndex();

		}
	}).fail( function(xhr, textStatus, errorThrown) {
        sjs.alert.message("Unfortunately, there was an error saving this text information. Please try again or try reloading this page.")
    });
	
};


sjs.translateText = function(data) {
	// Transistion to the UI for adding a translation of the text
	// in data.
	if ("error" in data) {
		sjs.alert.message(data.error);
		return;
	} 
	sjs.editing = data;
	sjs.langMode = 'he';
	if (data.sectionNames.length === data.sections.length) {
		sjs.editing.offset = data.sections[data.sections.length - 1];
	}
	sjs.showNewVersion();
};


function validateText(text) {
	if (text.versionTitle === "" || !text.versionTitle) {
		sjs.alert.message("Please give a version title.");
		return false;
	}
	
	if (text.versionSource === "" ) {
	 	sjs.alert.message("Please indicate where this text was copied from.");
	 	return false;
	}

	if (text.language === "he" && text.versionTitle === "Sefaria Community Translation") {
		sjs.alert.message('"Original Translations" should not be Hebrew. Is this actually a copied text?');
	 	return false;
	}

	return true;
}


function validateSource(source) {
	if (!source || source.refs.length != 2) {
		sjs.alert.message("Didn't receive a source or refs.");
		return false;
	}
	
	return true; 
}


function handleSaveSource(e) {
	if ($("#addSourceSave").text() == "Add Text") {
		// This is a an unknown text, add an index first
		var title = $("#addSourceCitation").val()
		$("#textTitle").val(title);
		$(".textName").text(title);
		$("#newIndexMsg").show();
		sjs.showNewIndex();
		return;
	}
	
	var source = readSource();
	if (validateSource(source)) {
		sjs.sourcesFilter = sjs.sourcesFilter = 'all';
		saveSource(source);
		if ("_id" in source) {
			sjs.track.action("Edit Source");
		} else {
			sjs.track.action("New Source");
		}
	}
	e.stopPropagation();
}


function readSource() {
	// Returns an object representing a new Source based on the state
	// of the form in the DOM.
	var source = {}
	var ref1 = sjs.add.source.ref.replace(/:/g, ".") 
	var ref2 = $("#addSourceCitation").val().replace(/:/g, ".");
	ref2 = makeRef(parseRef(ref2));
	
	source["refs"] = [ref1, ref2];
	
	var id = $(".open").attr("data-id");
	if (id) {
		source["_id"] = sjs.current.commentary[id]._id;
	}

	source["anchorText"] = $("#anchorForm input").val();
	source["type"] = $("#addSourceType select").val();
	if (source["type"] === "other") source["type"] = $("#otherType").val();
			
	return source;
	
}


function handleDeleteSource(e) {
	if (!sjs._uid) {
		return sjs.loginPrompt();
	}		
	if (confirm("Are you sure you want to delete this source?")) {
		var link   = {};
		var $modal = $(this).parents(".open");
		var id     = $modal.attr("data-id");
		var data   = $modal.hasClass("noteMode") ? sjs.current.notes : sjs.current.commentary;
		var com    = data[id];
		var url    = ($(this).parents(".open").hasClass("noteMode") ? "/api/notes/" : "/api/links/") + com["_id"];
		$(".open").remove();
		$.ajax({
			type: "delete",
			url: url,
			success: function() { 
				hardRefresh()
				sjs.alert.message("Source deleted.");
			},
			error: function () {
				sjs.alert.message("Something went wrong (that's all I know).");
			}
		});
	}

}


function validateNote(note) {
	if (!note) {
		sjs.alert.message("Didn't receive a note.");
		return false;
	}
	
	if (!note.title) {
	//	sjs.alert.message("Please give this note a title.");
	//	return false; 
	}
	
	if (!note.text) {
		sjs.alert.message("Please enter a note text.");
		return false; 
	}

	return true; 
}


function handleSaveNote(e) {
	var note = readNote();	
	if (validateNote(note)) {
		if (sjs.sourcesFilter != "Notes") {
			// enter Note mode, so saved note is visible once saved
			sjs.previousFilter = sjs.sourcesFilter;
			sjs.sourcesFilter = "Notes";
		}
		saveSource(note);
		if ("_id" in note) {
			sjs.track.action("Edit Note");
		} else {
			sjs.track.action("New Note");
		}
	} 
	e.stopPropagation();
}


function readNote() {
	var note = {
		ref: sjs.add.source.ref.replace(/:/g, "."),
		anchorText: $("#anchorForm input").val(),
		type:  "note",
		title: $("#addNoteTitle").val(),
		text: $("#addNoteTextarea").val(),
		public: $("#publicNote").is(":checked")
	};

	var id = $(".open").attr("data-id");
	if (id) {
		note["_id"] = sjs.current.notes[id]["_id"];
	}

	return note;
}


function saveSource(source) {
 	var postJSON = JSON.stringify(source);
	sjs.alert.saving("Saving Source…");
	$(".open").remove();
	var url = ("_id" in source ? "/api/links/" + source["_id"] : "/api/links/");
	$.post(url, {"json": postJSON}, function(data) {
		sjs.alert.clear();
		if (data.error) {
			sjs.alert.message(data.error);
		} else if (data) {
			updateSources(data);
		} else {
			sjs.alert.message("Sorry, there was a problem saving your source.");
		}
	}).fail( function(xhr, textStatus, errorThrown) {
        sjs.alert.message("Unfortunately, there was an error saving this source. Please try again or try reloading this page.")
    });
}


function updateSources(source) {
	// Take a single source object
	// add it to the DOM or update the existing source

	var list = (sjs.sourcesFilter == "Notes" ? sjs.current.notes : sjs.current.commentary);

	var id = -1;
	for (var i = 0; i < list.length; i++) {
		if (list[i]._id === source._id) {
			list[i] = source;
			id = i;
			break;
		}
	}
	if (id == -1) {
		id = list.length;
		list.push(source);
	}
	sjs.cache.save(sjs.current);
	console.log(source);

	buildCommentary(list);
	sjs._$commentary = $(".commentary");
	$(".noCommentary").removeClass("noCommentary");
	$highlight = sjs._$basetext.find(".verse").not(".lowlight").first();
	if ($highlight.length) {
 		var top = $highlight.position().top - 100;
		$("html, body").animate({scrollTop: top}, 1);
	}
	$(".commentary[data-id='" + id + "']").trigger("click");
}


function checkTextDirection() {
	// Check if the text is (mostly) Hebrew, update text direction
	// and language setting accordingly
	
	var text = $(this).val();
	if (text == "") { return; }
	
	if (isHebrew(text)) {
		$(this).css("direction", "rtl");
		$("#language").val("he");
		
	} else {	
		$(this).css("direction", "ltr");
		$("#language").val("en");
	}
}


// ------ Text Syncing (matching textarea groups to labels or original text) -----------

htc = 0		
function handleTextChange(e) {
	// Special considerations every time the text area changes

	// Ignore arrow keys, but capture new char before cursor
	if (e.keyCode in {37:1, 38:1, 39:1, 40:1}) { 
		var cursor = sjs._$newVersion.caret().start;
		sjs.charBeforeCursor = sjs._$newVersion.val()[cursor-1];
		return; 
	}

	htc++

	var text = sjs._$newVersion.val();
	var cursor = sjs._$newVersion.caret().start;

	// BACKSPACE
	// Handle deleting border between segments 
	if (e.keyCode == 8 && sjs.charBeforeCursor == '\n') {		
		if (cursor) {
			
			// Advance cursor to end of \n seqeuence
			while (text[cursor] == "\n") cursor++;
			
			// Count back to beginning for total number of new lines
			var newLines = 0;
			while (text[cursor-newLines-1] == "\n") newLines++;
			
			// Remove the new lines
			if (newLines) {
				text = text.substr(0, cursor-newLines) + text.substr(cursor)
				sjs._$newVersion.val(text)
					.caret({start: cursor-newLines, end: cursor-newLines})

			}
		}
	}

	// ENTER
	// Insert placeholder "..." when hitting enter mutliple times to allow
	// skipping ahead to a further segment
	if (e.keyCode === 13 && (sjs.charBeforeCursor === '\n' || sjs.charBeforeCursor === undefined)) {
		text = text.substr(0, cursor-1) + "...\n\n" + text.substr(cursor);
		sjs._$newVersion.val(text);
		cursor += 4;
		sjs._$newVersion.caret({start: cursor, end: cursor});

	}

	// replace any single newlines with a double newline
	var single_newlines = /([^\n])\n([^\n])/g;
	if (single_newlines.test(text)) {
		text = text.replace(single_newlines, "$1\n\n$2");
		sjs._$newVersion.val(text);
		// move the cursor to the position after the second newline
		if (cursor) {
			cursor++;
			sjs._$newVersion.caret({start: cursor, end: cursor});
		}
	}
	

	// Sync Text with Labels	
	if ($("body").hasClass("newText")) {
		var matches = sjs._$newVersion.val().match(/\n+/g)
		var groups = matches ? matches.length + 1 : 1
		numStr = "";
		var offset = sjs.editing.offset || 1;
		for (var i = offset; i < groups + offset; i++) {
			numStr += "<div class='verse'>"+
				sjs.editing.smallSectionName + " " + i + "</div>"
		}
		$("#newTextNumbers").empty().append(numStr)

		sjs._$newNumbers = $("#newTextNumbers .verse")
		syncTextGroups(sjs._$newNumbers)

	} else {
		syncTextGroups($("#newTextCompare .verse"))

	}
	var cursor = sjs._$newVersion.caret().start;
	sjs.charBeforeCursor = sjs._$newVersion.val()[cursor-1];

}
	

gh = 0;
function groupHeights(verses) {
	// Returns an array of the heights (offset top) of text groups in #newVersion
	// where groups are seprated by '\n\n'
	// 'verses' is the maximum number of groups to look at

	gh++;

	var text = sjs._$newVersion.val();
	
	// Split text intro groups and wrap each group with in class heightMarker
	text =  "<span class='heightMarker'>" +
		text.replace(/\n/g, "<br>")
		.replace(/((<br>)+)/g, "$1<split!>")
		.split("<split!>")
		.join("</span><span class='heightMarker'>") +
		".</span>"; 
		// Last span includes '.', to prevent an empty span for a trailing line break.
		// Empty spans get no positioning. 

	// New Version Mirror is a HTML div whose contents mirror exactly the text area
	// It is shown to measure heights then hidden when done.
	sjs._$newVersionMirror.html(text).show();
	
	var heights = [];
	for (i = 0; i < verses; i++) {
		// Stop counting if there are less heightMarkers than $targets
		if (i > $('.heightMarker').length - 1) { 
			break; 
		}

		heights[i] = $(".heightMarker").eq(i).offset().top;
	}

	sjs._$newVersionMirror.hide();
	
	return heights;
}


stg = 0;
function syncTextGroups($target) {
	// Between $target (a set of elements) and textarea (fixed in code as sjs._$newVersion)
	// sync the height of groups by either adding margin-bottom to elements of $target
	// or adding adding \n between groups in newVersion.

	stg++;

	var verses = $target.length;
	var heights = groupHeights(verses);
	// cursorCount tracks the number of newlines added before the cursor
	// so that we can move the cursor to the correct place at the end
	// of the loop.
	var cursorCount = 0;
	var cursorPos = sjs._$newVersion.caret().start;

	for (var i = 1; i < verses; i++) {
		// top of the "verse", or label trying to match to
		var vTop = $target.eq(i).offset().top;

		// top of the text group
		var tTop = heights[i];

		var diff = vTop - tTop;

		if (!tTop) { break; }
		
		if (diff < 0) {
			// Label is above text group
			// Add margin-bottom to preceeding label to push it down

			var marginBottom = parseInt($target.eq(i-1).css("margin-bottom")) - diff;
			
			$target.eq(i-1).css("margin-bottom", marginBottom + "px");
			
		} else if (diff > 0) {
			// Text group is above label
			// First try to reset border above and try cycle again
			if (parseInt($target.eq(i-1).css("margin-bottom")) > 32) {
				$target.eq(i-1).css("margin-bottom", "32px");
				i--;
				continue;
			}
			// Else add extra new lines to push down text and try again
			var text = sjs._$newVersion.val();
			
			// search for new line groups i times to find the position of insertion
			var regex = new RegExp("\n+", "g");
			for (var k = 0; k < i; k++) {
				var m = regex.exec(text);
			}

			var nNewLines = Math.ceil(diff / 32); // divide by height of new line
			var newLines = Array(nNewLines+1).join("\n");
			text = text.substr(0, m.index) + newLines + text.substr(m.index);
			
			sjs._$newVersion.val(text);

			if (m.index < cursorPos) {
				cursorCount += nNewLines;
			}

			sjs._$newVersion.caret({start: cursorPos, end: cursorPos});
			heights = groupHeights(verses);
			i--;
		}	
	
	}
	if (cursorCount > 0) {
		cursorPos = cursorPos + cursorCount;
		sjs._$newVersion.caret({start: cursorPos, end: cursorPos});
	}

}


function readNewVersion() {
	// Returns on object corresponding to a text segment from the text fields
	// in the DOM.
	// Called "new version" by legacy when a text was referred to as a 'version'.
	var version = {};

	version.postUrl = sjs.editing.book.replace(/ /g, "_");
	for (var i= 0 ; i < sjs.editing.sectionNames.length - 1; i++) {
		version.postUrl += "." + sjs.editing.sections[i];
	}
	
	if ($("#originalRadio").prop("checked")) {
		version["versionTitle"] = "Sefaria Community Translation";
		version["versionSource"] = "http://www.sefaria.org";
	} else {
		version["versionTitle"] = $("#versionTitle").val();
		var source = $("#versionSource").val();
		if (source.indexOf(" ") == -1 && source.indexOf("http://") != 0) {
			source = source ? "http://" + source : source;
		} 
		version["versionSource"] = source;
	}

	var text = $("#newVersion").val();
	if (text) {
		var verses = text.split(/\n\n+/g);
	} else {
		// Avoid treating an empty textarea as [""] which is interrpreted as
		// 'a first segment exists, but we don't have it'. This should actually
		// be saved as empty.
		var verses = [];
	}
	for (var i=0; i < verses.length; i++) {
		// Treat "..." as empty placeholder ('this segment exists, but we don't have it')
		verses[i] = (verses[i] === "..." ? "" : verses[i]);
	}
	if (sjs.editing.offset) {
		var filler = [];
		for (var i = 0; i < sjs.editing.offset -1; i++) {
			if (sjs.editing.versionTitle === version.versionTitle) {
				filler.push(sjs.editing.text[i]);
			} else {
				// TODO this may overwrite if i switch to a new version
				// which exists already.
				filler.push("");
			}
		}
		verses = filler.concat(verses);
	}
	version["text"] = verses;
	version["language"] = $("#language").val();

	return version;
	
}

	
function saveText(text) {
 	// Posts the obect 'text' to save via the texts API.
 	var ref = text.postUrl;
 	delete text["postUrl"];
 	
 	postJSON = JSON.stringify(text);
	
	sjs.alert.saving("Saving text...")
	$.post("/api/texts/" + ref, {json: postJSON}, function(data) {
		if ("error" in data) {
		 	sjs.alert.message(data.error);
		} else {
			sjs.clearNewText();
			var params = getUrlVars();
			if ("after" in params) {
				if (params["after"].indexOf("/sheets") == 0) {
					sjs.alert.messageOnly("Text saved.<br><br><a href='" + params["after"] + "'>Back to your source sheet &raquo;</a>");
				}
			} else {
				hardRefresh(ref);
				sjs.editing = {};
				sjs.alert.message("Text saved.");
			}


		}
	}).fail( function(xhr, textStatus, errorThrown) {
        sjs.alert.message("Unfortunately, there was an error saving this text. Please try again or try reloading this page.")
    });
}


function lowlightOn(n, m) {
	// Turn on lowlight, leaving verses n-m highlighted
	lowlightOff();
	m = m || n;
	n = parseInt(n);
	m = parseInt(m);
	$c = $();
	for (var i = n; i <= m; i++ ) {
		$c = $c.add(sjs._$commentaryViewPort.find(".commentary[data-vref~="+ i + "]"));
	}
	sjs._$commentaryViewPort.find(".commentary").addClass("lowlight");
	$c.removeClass("lowlight");
	sjs._$verses.addClass("lowlight" );
	sjs._$verses.each(function() {
		if (n <= parseInt($(this).attr("data-num")) && parseInt($(this).attr("data-num"))  <= m) {
			$(this).removeClass("lowlight");
		}
	});
}


function lowlightOff() {
	// Turn off any lowlight effect
	if ($(".lowlight").length == 0) { return; }
	$(".lowlight").removeClass("lowlight");
	$(".verseControls").remove();
	sjs.selected = null;
	if ("commentary" in sjs.current) {
		sjs.setSourcesCount();
		sjs.setSourcesPanel();
	}
}


function setVerseHeights() {
	// Store a list of the top height of each verse
	sjs._verseHeights = [];
	if (!sjs._$verses) { return; }
	sjs._$verses.each(function() {
		sjs._verseHeights.push($(this).offset().top);
	})	
}


function setScrollMap() {
	// Maps each commentary to a window scrollTop position, based on top positions of verses.
	// scrollMap[i] is the window scrollTop below which commentary i should be displayed at top.
	if(!sjs._verseHeights.length) { setVerseHeights(); }
	sjs._scrollMap = [];
	var nVerses = sjs._$verses.length;

	// walk through all verses, split its space among its commentaries
	for (var i = 0; i < nVerses; i++) {
		
		// The top of the previous verse assigned:
		var prevTop = (i === 0 ?  0 : sjs._verseHeights[i-1]);
		// The number of commentaries this verse has:
		var nCommentaries = sjs._$commentaryViewPort.find(".commentary[data-vref="+ (i+1) + "]").not(".hidden").length;
		// How much vertical space is available before the next verse
		// Special case the last verse which has no boundary after it
		var space = (i === nVerses-1 ? nCommentaries * 10 : sjs._verseHeights[i] - prevTop);

		// walk through each source this verse has
		for (k = 0; k < nCommentaries; k++) {
			sjs._scrollMap.push(prevTop + (k * (space / nCommentaries)));
		}
	}
	
	return sjs._scrollMap;
}

sjs.searchInsteadOfNav = function (query) {
	// Displays an option under the search box to search for 'query' rather
	// than treat it as a navigational query.
	var html = "<div id='searchInsteadOfNavPrompt'>" + 
					"Search for '<a href='/search?q=" + query + "'>" + query + "</a>' instead." +
				"</div>";
	$("#searchInsteadOfNavPrompt").remove();
	$(html).appendTo("body").css({left: $("#goto").offset().left});
	setTimeout('$("#searchInsteadOfNavPrompt").remove();', 4000);
};


function hardRefresh(ref) {
	// Fully reset page and rebuild view for ref.
	ref = ref || sjs.current.ref;
	sjs._direction = 0;
	sjs.cache.killAll();
	$(".screen").hide();
	actuallyGet(parseRef(ref));	
}


// -------- Special Case for IE ----------------
if ($.browser.msie) {
	$("#unsupported").show();
	$.isReady = true;
}
